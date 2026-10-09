import { describe, expect, it } from 'vitest';
import { readCompose } from '../../support/deployment.js';

describe('compose.yaml', () => {
  it('DEP-R02 starts migrate after postgres is healthy, the replicas after migrate exits 0, nginx after both are healthy, and tools only on demand', () => {
    const compose = readCompose();

    expect(compose.service('migrate').dependsOn).toEqual({
      postgres: { condition: 'service_healthy' },
    });
    for (const name of ['api-1', 'api-2']) {
      expect(compose.service(name).dependsOn, name).toEqual({
        migrate: { condition: 'service_completed_successfully' },
        redis: { condition: 'service_started' },
      });
    }
    expect(compose.service('nginx').dependsOn).toEqual({
      'api-1': { condition: 'service_healthy' },
      'api-2': { condition: 'service_healthy' },
    });
    expect(compose.service('tools').dependsOn).toEqual({
      nginx: { condition: 'service_started' },
    });
    expect(compose.service('tools').profiles).toEqual(['tools']);
    for (const service of compose.services.filter((service) => service.name !== 'tools')) {
      expect(service.profiles, service.name).toEqual([]);
    }
  });

  it('DEP-R02 runs migrate, the replicas and tools from the image, the replicas with REPLICA_ID api-1 and api-2', () => {
    const compose = readCompose();

    expect(compose.services.map((service) => service.name).sort()).toEqual(
      ['api-1', 'api-2', 'migrate', 'nginx', 'postgres', 'redis', 'tools'].sort(),
    );
    expect(compose.service('migrate').buildTarget).toBe('runtime');
    expect(compose.service('migrate').entrypoint).toEqual(['node', 'dist/cli/migrate.js', 'up']);
    expect(compose.service('tools').buildTarget).toBe('tools');
    expect(compose.replicas().map((service) => service.name)).toEqual(['api-1', 'api-2']);
    for (const replica of compose.replicas()) {
      expect(replica.buildTarget, replica.name).toBe('runtime');
      expect(replica.environment['REPLICA_ID'], replica.name).toBe(replica.name);
      // The image's entrypoint and healthcheck run unchanged.
      expect(replica.entrypoint, replica.name).toBeUndefined();
      expect(replica.raw['healthcheck'], replica.name).toBeUndefined();
    }
  });

  it('DEP-R06 needs no .env file: no env_file, and every variable the service requires has a value', () => {
    const compose = readCompose();

    for (const service of compose.services) expect(service.hasEnvFile, service.name).toBe(false);
    const required = [
      'DATABASE_URL',
      'REDIS_URL',
      'JWT_SECRET',
      'JWT_ISSUER',
      'JWT_AUDIENCE',
      'CURSOR_SECRET',
    ];
    for (const service of [...compose.replicas(), compose.service('tools')]) {
      for (const variable of required) {
        expect(service.environment[variable], `${service.name} ${variable}`).toMatch(/\S/);
        // A literal, so a stray .env cannot change it (section 1.4).
        expect(service.rawEnvironment[variable], `${service.name} ${variable}`).not.toContain('$');
      }
    }
    expect(compose.service('migrate').environment['MIGRATION_DATABASE_URL']).toMatch(
      /^postgres:\/\/scf_owner:/,
    );
    expect(compose.service('tools').environment['MIGRATION_DATABASE_URL']).toMatch(
      /^postgres:\/\/scf_owner:/,
    );
    // The replicas connect as the runtime role and never get the owner role's URL (DEP-R05).
    for (const replica of compose.replicas()) {
      expect(replica.environment['DATABASE_URL'], replica.name).toMatch(/^postgres:\/\/scf_app:/);
      expect(replica.environment['MIGRATION_DATABASE_URL'], replica.name).toBeUndefined();
    }
  });

  it('DEP-R08 publishes only the ports of table 1.1, each on 127.0.0.1, and exposes nothing else', () => {
    const compose = readCompose();

    const published = compose.services.flatMap((service) =>
      service.ports.map((port) => ({ service: service.name, ...port })),
    );
    expect(published).toEqual([
      { service: 'postgres', hostIp: '127.0.0.1', hostPort: '55432', containerPort: '5432' },
      { service: 'redis', hostIp: '127.0.0.1', hostPort: '6379', containerPort: '6379' },
      { service: 'api-1', hostIp: '127.0.0.1', hostPort: '3001', containerPort: '3000' },
      { service: 'api-2', hostIp: '127.0.0.1', hostPort: '3002', containerPort: '3000' },
      { service: 'nginx', hostIp: '127.0.0.1', hostPort: '8080', containerPort: '8080' },
    ]);
    for (const service of compose.services) expect(service.expose, service.name).toEqual([]);
  });
});
