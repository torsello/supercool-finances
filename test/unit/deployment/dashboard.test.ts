import { describe, expect, it } from 'vitest';
import { Metrics } from '../../../src/platform/metrics/metrics.js';
import { readRepositoryFile } from '../../support/deployment.js';

interface Panel {
  title: string;
  type: string;
  targets?: { expr: string; refId: string }[];
}

interface Dashboard {
  uid: string;
  editable: boolean;
  panels: Panel[];
}

/** The panel titles of the table of section 1.9 of spec 008, in order. */
function specPanelTitles(): string[] {
  const spec = readRepositoryFile('specs/008-deployment/spec.md');
  const section = spec.slice(spec.indexOf('### 1.9 '), spec.indexOf('\n## 2. '));
  return section
    .split('\n')
    .filter(
      (line) => line.startsWith('| ') && !line.startsWith('| Panel') && !line.startsWith('| -'),
    )
    .map((line) => (line.split('|')[1] ?? '').trim());
}

/** The names the service registers, with the series of each histogram. */
async function registeredSeries(): Promise<Set<string>> {
  const metrics = new Metrics({ pool: { totalCount: 0, idleCount: 0, waitingCount: 0 } });
  const names = new Set<string>();
  for (const metric of await metrics.registry.getMetricsAsJSON()) {
    names.add(metric.name);
    if (metric.type === 'histogram') {
      for (const suffix of ['_bucket', '_count', '_sum']) names.add(`${metric.name}${suffix}`);
    }
  }
  return names;
}

/** The PromQL functions, keywords and label names the dashboard's queries may use. */
const NOT_METRICS = new Set([
  'sum',
  'by',
  'rate',
  'label_replace',
  'histogram_quantile',
  // A series at 0 where no request matched, so the errors panel shows 0 rather than no data.
  'or',
  'vector',
  'job',
  'replica',
  'route',
  'status_code',
  'status_class',
  'le',
  'kind',
  'outcome',
  'lock',
  'state',
]);

/** Every identifier of a query outside its strings and range selectors. */
function identifiersOf(expr: string): string[] {
  const bare = expr.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\[[^\]]*\]/g, '');
  return [...bare.matchAll(/[A-Za-z_:][A-Za-z0-9_:]*/g)].map((match) => match[0]);
}

describe('the Grafana dashboard', () => {
  it('DEP-AC32 has one panel per row of section 1.9, built only from the metrics the service registers and up', async () => {
    const dashboard = JSON.parse(
      readRepositoryFile('docker/grafana/dashboards/scf-overview.json'),
    ) as Dashboard;
    const series = await registeredSeries();

    expect(dashboard.uid).toBe('scf-overview');
    expect(dashboard.editable).toBe(false);
    const titles = specPanelTitles();
    expect(titles).toHaveLength(9);
    expect(dashboard.panels.map((panel) => panel.title)).toEqual(titles);
    const used = new Set<string>();
    for (const panel of dashboard.panels) {
      expect(panel.targets?.length ?? 0, panel.title).toBeGreaterThan(0);
      for (const target of panel.targets ?? []) {
        for (const name of identifiersOf(target.expr)) {
          if (NOT_METRICS.has(name)) continue;
          expect(name === 'up' || series.has(name), `${panel.title}: ${name}`).toBe(true);
          used.add(name);
        }
      }
    }
    for (const name of [
      'up',
      'scf_http_request_duration_seconds_count',
      'scf_http_request_duration_seconds_bucket',
      'scf_money_movements_total',
      'scf_lock_timeouts_total',
      'scf_idempotent_replays_total',
      'scf_rate_limited_total',
      'scf_db_pool_connections',
      'scf_db_pool_acquire_timeouts_total',
    ]) {
      expect(used.has(name), name).toBe(true);
    }

    const latency = dashboard.panels.find((panel) => panel.title === 'Latency p50, p95 and p99');
    const quantiles = (latency?.targets ?? []).map(
      (target) => /histogram_quantile\(([0-9.]+),/.exec(target.expr)?.[1],
    );
    expect(quantiles).toEqual(['0.5', '0.95', '0.99']);
  });
});
