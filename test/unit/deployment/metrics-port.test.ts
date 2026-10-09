import { describe, expect, it } from 'vitest';
import {
  findDirectives,
  readCompose,
  readNginxTemplate,
  replicaConfig,
} from '../../support/deployment.js';

describe('the metrics port', () => {
  it('SEC-AC33 every upstream and proxy_pass of the load balancer targets the replicas’ PORT, none METRICS_PORT, and no service publishes METRICS_PORT', () => {
    const compose = readCompose();
    const template = readNginxTemplate();
    const ports = new Set(compose.replicas().map((replica) => replicaConfig(replica).port));
    const metricsPorts = new Set(
      compose.replicas().map((replica) => replicaConfig(replica).metricsPort),
    );
    expect([...ports]).toEqual([3000]);
    expect([...metricsPorts]).toEqual([9464]);

    const upstreams = findDirectives(template, 'upstream');
    const servers = upstreams.flatMap((upstream) =>
      (upstream.block ?? []).filter((directive) => directive.name === 'server'),
    );
    expect(servers.length).toBeGreaterThan(0);
    for (const server of servers) {
      const port = /:([0-9]+)$/.exec(server.args[0] ?? '')?.[1];
      expect(Number(port), server.args[0]).toBe(3000);
    }
    const upstreamNames = new Set(upstreams.map((upstream) => upstream.args[0]));
    const passes = findDirectives(template, 'proxy_pass');
    expect(passes.length).toBeGreaterThan(0);
    for (const pass of passes) {
      const target = /^https?:\/\/([^/]+)/.exec(pass.args[0] ?? '')?.[1] ?? '';
      const port = /:([0-9]+)$/.exec(target)?.[1];
      expect(
        upstreamNames.has(target) || Number(port) === 3000,
        `proxy_pass ${pass.args[0] ?? ''}`,
      ).toBe(true);
    }
    expect(JSON.stringify(template)).not.toContain('9464');

    for (const service of compose.services) {
      for (const port of service.ports) {
        expect(port.containerPort, service.name).not.toBe('9464');
        expect(port.hostPort, service.name).not.toBe('9464');
      }
      expect(service.expose, service.name).not.toContain('9464');
    }
  });
});
