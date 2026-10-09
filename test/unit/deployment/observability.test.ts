import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseCompose, readCompose, readRepositoryFile } from '../../support/deployment.js';

/** A YAML file of the repository, parsed. */
function readYaml(path: string): Record<string, unknown> {
  return parse(readRepositoryFile(path)) as Record<string, unknown>;
}

/** The recipe lines of a `Makefile` target, without their leading tab. */
function recipeOf(makefile: string, target: string): string[] {
  const lines = makefile.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${target}:`));
  if (start === -1) throw new Error(`no target ${target} in the Makefile`);
  const recipe: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('\t')) break;
    recipe.push(line.slice(1));
  }
  return recipe;
}

interface ScrapeConfig {
  job_name: string;
  scrape_interval?: string;
  static_configs: { targets: string[]; labels?: Record<string, string> }[];
}

describe('the observability profile', () => {
  it('DEP-AC31 runs Prometheus and Grafana only in the profile observability, Prometheus unpublished and Grafana read-only on 127.0.0.1:3030', () => {
    const compose = readCompose();
    const prometheus = compose.service('prometheus');
    const grafana = compose.service('grafana');

    expect(prometheus.profiles).toEqual(['observability']);
    expect(grafana.profiles).toEqual(['observability']);
    for (const service of compose.services) {
      if (['prometheus', 'grafana', 'tools'].includes(service.name)) continue;
      expect(service.profiles, service.name).toEqual([]);
    }
    expect(prometheus.ports).toEqual([]);
    expect(grafana.ports).toEqual([
      { hostIp: '127.0.0.1', hostPort: '3030', containerPort: '3000' },
    ]);

    const metricsPorts = new Set(
      compose.replicas().map((replica) => replica.environment['METRICS_PORT']),
    );
    expect(metricsPorts.size).toBe(1);
    const [metricsPort] = [...metricsPorts];
    const config = readYaml('docker/prometheus/prometheus.yml') as {
      global?: { scrape_interval?: string };
      scrape_configs: ScrapeConfig[];
    };
    expect(config.scrape_configs).toHaveLength(1);
    const [job] = config.scrape_configs;
    expect(job?.job_name).toBe('scf-api');
    expect(job?.scrape_interval ?? config.global?.scrape_interval).toBe('5s');
    const targets = (job?.static_configs ?? []).flatMap((group) => group.targets);
    expect(targets.sort()).toEqual([
      `api-1:${String(metricsPort)}`,
      `api-2:${String(metricsPort)}`,
    ]);
    for (const group of job?.static_configs ?? []) {
      for (const target of group.targets) {
        expect(group.labels?.['replica'], target).toBe(target.split(':')[0]);
      }
    }

    expect(grafana.environment).toMatchObject({
      GF_AUTH_ANONYMOUS_ENABLED: 'true',
      GF_AUTH_ANONYMOUS_ORG_ROLE: 'Viewer',
      GF_AUTH_DISABLE_LOGIN_FORM: 'true',
      GF_AUTH_BASIC_ENABLED: 'false',
      GF_USERS_ALLOW_SIGN_UP: 'false',
      GF_ANALYTICS_REPORTING_ENABLED: 'false',
      GF_ANALYTICS_CHECK_FOR_UPDATES: 'false',
    });
    const datasources = readYaml('docker/grafana/provisioning/datasources/prometheus.yaml') as {
      datasources: { type: string; url: string; editable: boolean }[];
    };
    expect(datasources.datasources).toEqual([
      expect.objectContaining({
        type: 'prometheus',
        url: 'http://prometheus:9090',
        editable: false,
      }),
    ]);
    const providers = readYaml('docker/grafana/provisioning/dashboards/scf.yaml') as {
      providers: { allowUiUpdates: boolean }[];
    };
    expect(providers.providers).toEqual([expect.objectContaining({ allowUiUpdates: false })]);
    expect(prometheus.hasEnvFile).toBe(false);
    expect(grafana.hasEnvFile).toBe(false);

    expect(recipeOf(readRepositoryFile('Makefile'), 'observability')).toEqual([
      '$(COMPOSE) --profile observability up --build --wait',
    ]);
    expect(readRepositoryFile('Makefile')).toMatch(/^COMPOSE \?= docker compose$/m);
  });

  it('DEP-AC34 compose.yaml never passes SENTRY_DSN, and compose.error-reporting.yaml passes only it, to the replicas, required', () => {
    const compose = readCompose();
    for (const service of compose.services) {
      expect(service.rawEnvironment['SENTRY_DSN'], service.name).toBeUndefined();
    }
    expect(readRepositoryFile('compose.yaml')).not.toContain('SENTRY_DSN');

    const override = parseCompose(readRepositoryFile('compose.error-reporting.yaml'));
    expect(override.services.map((service) => service.name)).toEqual(['api-1', 'api-2']);
    for (const service of override.services) {
      expect(Object.keys(service.raw), service.name).toEqual(['environment']);
      expect(Object.keys(service.rawEnvironment), service.name).toEqual(['SENTRY_DSN']);
      expect(service.rawEnvironment['SENTRY_DSN'], service.name).toMatch(
        /^\$\{SENTRY_DSN:\?[^}]*SENTRY_DSN[^}]*\}$/,
      );
      expect(service.image).toBeUndefined();
      expect(service.buildTarget).toBeUndefined();
      expect(service.ports).toEqual([]);
      expect(service.profiles).toEqual([]);
      expect(service.hasEnvFile).toBe(false);
    }
  });
});
