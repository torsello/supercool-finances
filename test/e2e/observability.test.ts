import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCompose } from '../support/deployment.js';
import { createAccount, deposit, getAccount, withdraw } from './support/api.js';
import { expectStatus, headerOf, jsonOf, send, type E2eResponse } from './support/http.js';
import {
  ensureStack,
  removeObservability,
  serviceStates,
  startObservability,
} from './support/stack.js';
import { freshUser } from './support/tokens.js';
import { BASE_URL, publishedPort, REPLICAS, replicaUrl } from './support/urls.js';
import { waitFor } from './support/wait.js';

/** Grafana as the host reaches it: the host of `E2E_BASE_URL` and Grafana's published port. */
function grafanaUrl(path: string): string {
  const url = new URL(BASE_URL);
  url.port = publishedPort('grafana', '3000');
  return `${url.origin}${path}`;
}

/** A request to Grafana without credentials, as an anonymous visitor. */
async function grafana(method: string, path: string, body?: unknown): Promise<E2eResponse> {
  return await send({ method, url: grafanaUrl(path), body, record: false });
}

interface Panel {
  title: string;
  targets: { refId: string; expr: string }[];
}

interface Dashboard {
  uid: string;
  version: number;
  panels: Panel[];
}

/** One series of a query's answer: its labels and its last value. */
interface Series {
  labels: Record<string, string>;
  value: number;
}

interface Frame {
  schema: { fields: { name: string; labels?: Record<string, string> }[] };
  data: { values: unknown[][] };
}

/**
 * Evaluates `expr` through Grafana's query API, as a panel does, over the last 5 minutes; fails
 * when Grafana or Prometheus answers an error, and answers the last value of each series.
 */
async function query(expr: string): Promise<Series[]> {
  const response = await grafana('POST', '/api/ds/query', {
    from: 'now-5m',
    to: 'now',
    queries: [
      {
        refId: 'A',
        datasource: { type: 'prometheus', uid: 'scf-prometheus' },
        expr,
        range: true,
        instant: false,
        intervalMs: 5000,
        maxDataPoints: 100,
      },
    ],
  });
  expectStatus(response, 200);
  const result = (
    jsonOf(response) as { results: { A: { status: number; error?: string; frames?: Frame[] } } }
  ).results.A;
  expect(result.error, expr).toBeUndefined();
  expect(result.status, expr).toBe(200);
  return (result.frames ?? []).map((frame) => {
    const values = frame.data.values[1] ?? [];
    return {
      labels: frame.schema.fields[1]?.labels ?? {},
      value: Number(values[values.length - 1]),
    };
  });
}

describe('the observability profile', () => {
  beforeAll(async () => {
    await ensureStack();
    await startObservability();
  });

  // Whether the AC passed or failed, so no later e2e file, the load test included, runs beside
  // Prometheus and Grafana (Q3 of spec 008).
  afterAll(async () => {
    await removeObservability();
    const running = (await serviceStates()).map((state) => state.Service);
    expect(running).not.toContain('prometheus');
    expect(running).not.toContain('grafana');
  });

  it('DEP-AC33 with the profile, Grafana shows both replicas and the movements, and refuses every change', async () => {
    // A rate needs two samples of a series, and the replicas may have restarted (DEP-AC11), which
    // resets their counters: so each counter the AC reads is first created on each replica, by
    // other users, and scraped once.
    const warmOperator = await freshUser('operator');
    const warmCustomer = await freshUser('customer');
    for (const replica of REPLICAS) {
      const base = replicaUrl(replica);
      const account = await createAccount(warmCustomer.token, 'EUR', { base });
      const key = randomUUID();
      expectStatus(await deposit(warmOperator.token, account.id, '1000', { base, key }), 201);
      expectStatus(await deposit(warmOperator.token, account.id, '1000', { base, key }), 201);
      expectStatus(await withdraw(warmCustomer.token, account.id, '5000', { base }), 422);
    }
    await waitFor(
      'the warm-up counters scraped from both replicas',
      async () => {
        for (const selector of [
          'scf_money_movements_total{kind="deposit",outcome="applied"}',
          'scf_money_movements_total{kind="withdrawal",outcome="rejected"}',
          'scf_idempotent_replays_total{kind="deposit"}',
        ]) {
          const replicas = new Set((await query(selector)).map((item) => item.labels['replica']));
          if (replicas.size !== 2) return undefined;
        }
        return true;
      },
      { timeoutMs: 90_000, intervalMs: 2000 },
    );

    const o1 = await freshUser('operator');
    const c1 = await freshUser('customer');
    const a1 = await createAccount(c1.token);
    const k1 = randomUUID();
    expectStatus(await deposit(o1.token, a1.id, '1000', { key: k1 }), 201);
    const replay = expectStatus(await deposit(o1.token, a1.id, '1000', { key: k1 }), 201);
    expect(headerOf(replay, 'idempotent-replayed')).toBe('true');
    expectStatus(await withdraw(c1.token, a1.id, '5000'), 422);
    for (let index = 0; index < 20; index += 1) {
      expectStatus(await getAccount(c1.token, a1.id), 200);
    }

    const before = jsonOf(
      expectStatus(await grafana('GET', '/api/dashboards/uid/scf-overview'), 200),
    ) as { dashboard: Dashboard };
    const dashboard = before.dashboard;
    const refused = [
      await grafana('POST', '/api/dashboards/db', {
        dashboard: { ...dashboard, uid: 'scf-copy', title: 'A copy', version: 0 },
        overwrite: true,
      }),
      await grafana('DELETE', '/api/dashboards/uid/scf-overview'),
      await grafana('POST', '/api/datasources', {
        name: 'another',
        type: 'prometheus',
        url: 'http://prometheus:9090',
        access: 'proxy',
      }),
    ];
    for (const response of refused) expect([401, 403]).toContain(response.status);
    const after = jsonOf(
      expectStatus(await grafana('GET', '/api/dashboards/uid/scf-overview'), 200),
    ) as { dashboard: Dashboard };
    expect(after.dashboard).toEqual(dashboard);
    expect((await grafana('GET', '/api/dashboards/uid/scf-copy')).status).toBe(404);

    const up = await waitFor('both replicas scraped', async () => {
      const series = await query('up{job="scf-api"}');
      return series.length === 2 && series.every((item) => item.value === 1) ? series : undefined;
    });
    expect(up.map((item) => item.labels['replica']).sort()).toEqual(['api-1', 'api-2']);

    const panel = (title: string): Panel => {
      const found = dashboard.panels.find((item) => item.title === title);
      if (found === undefined) throw new Error(`no panel ${title}`);
      return found;
    };
    const movements = panel('Money movements by kind and outcome').targets[0]?.expr ?? '';
    const replays = panel('Idempotent replays').targets[0]?.expr ?? '';
    const above = (series: Series[], labels: Record<string, string>) =>
      series.some(
        (item) =>
          Object.entries(labels).every(([name, value]) => item.labels[name] === value) &&
          item.value > 0,
      );
    await waitFor(
      'the movements and the replay in Grafana',
      async () => {
        const moved = await query(movements);
        const replayed = await query(replays);
        return above(moved, { kind: 'deposit', outcome: 'applied' }) &&
          above(moved, { kind: 'withdrawal', outcome: 'rejected' }) &&
          above(replayed, { kind: 'deposit' })
          ? true
          : undefined;
      },
      { timeoutMs: 90_000, intervalMs: 2000 },
    );
    for (const item of dashboard.panels) {
      for (const target of item.targets) await query(target.expr);
    }

    const metricsPort = readCompose().replicas()[0]?.environment['METRICS_PORT'] ?? '';
    const published = (await serviceStates())
      .flatMap((state) => state.Publishers ?? [])
      .filter((publisher) => publisher.PublishedPort !== 0)
      .map((publisher) => `${publisher.URL}:${String(publisher.PublishedPort)}`)
      .sort();
    expect(published).toEqual(
      [
        '127.0.0.1:55432',
        '127.0.0.1:6379',
        '127.0.0.1:3001',
        '127.0.0.1:3002',
        '127.0.0.1:8080',
        '127.0.0.1:3030',
      ].sort(),
    );
    for (const port of ['9090', metricsPort]) {
      expect(
        published.some((item) => item.endsWith(`:${port}`)),
        port,
      ).toBe(false);
    }
  });
});
