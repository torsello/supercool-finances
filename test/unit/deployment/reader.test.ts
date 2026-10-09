import { describe, expect, it } from 'vitest';
import {
  findDirectives,
  nginxTimeMs,
  onlyArgument,
  parseCompose,
  parseNginx,
  readCompose,
  readNginxTemplate,
  withDefaults,
} from '../../support/deployment.js';

const COMPOSE = `
x-env: &env
  A: one
  LIMIT: \${LIMIT:-300}
x-svc: &svc
  build:
    context: .
    target: runtime
  stop_grace_period: 40s
services:
  db:
    image: postgres:16@sha256:abc
    command: ['postgres', '-c', 'max_connections=50']
    ports:
      - '127.0.0.1:5432:5432'
  app-1:
    <<: *svc
    environment:
      <<: *env
      REPLICA_ID: app-1
    ports:
      - target: 3000
        published: 3001
        host_ip: 127.0.0.1
    depends_on:
      db:
        condition: service_healthy
  worker:
    build: .
    environment:
      - B=two
      - EMPTY
    ports:
      - '9000'
      - '8080:80'
    depends_on: [db]
    env_file: .env
    profiles: [extra]
`;

const NGINX = `
# a comment; with { braces }
upstream pool {
    server a:3000 resolve;   # trailing comment
}
map $http_x_id $id {
    ''      $request_id;
    default $http_x_id;
}
server {
    listen 8080;
    limit_req zone=z burst=\${BURST} nodelay;
    location / {
        proxy_pass http://pool;
        proxy_read_timeout 30s;
        proxy_set_header Connection '';
    }
    location @err {
        return 502 '{"a":"b;c","d":"$id"}';
    }
}
`;

describe('the deployment reader', () => {
  it('reads services, environments with defaults and merge keys, published ports, dependencies and profiles', () => {
    const compose = parseCompose(COMPOSE);

    expect(compose.services.map((service) => service.name)).toEqual(['db', 'app-1', 'worker']);
    const app = compose.service('app-1');
    expect(app.environment).toEqual({ A: 'one', LIMIT: '300', REPLICA_ID: 'app-1' });
    expect(app.rawEnvironment['LIMIT']).toBe('${LIMIT:-300}');
    expect(app.buildTarget).toBe('runtime');
    expect(app.stopGracePeriod).toBe('40s');
    expect(app.ports).toEqual([{ hostIp: '127.0.0.1', hostPort: '3001', containerPort: '3000' }]);
    expect(app.dependsOn).toEqual({ db: { condition: 'service_healthy' } });
    expect(compose.replicas().map((service) => service.name)).toEqual(['app-1']);

    const worker = compose.service('worker');
    expect(worker.environment).toEqual({ B: 'two', EMPTY: '' });
    expect(worker.buildTarget).toBe('');
    expect(worker.ports).toEqual([
      { hostIp: undefined, hostPort: undefined, containerPort: '9000' },
      { hostIp: undefined, hostPort: '8080', containerPort: '80' },
    ]);
    expect(worker.dependsOn).toEqual({ db: { condition: 'service_started' } });
    expect(worker.hasEnvFile).toBe(true);
    expect(worker.profiles).toEqual(['extra']);
    expect(compose.service('db').image).toBe('postgres:16@sha256:abc');
    expect(compose.service('db').command).toEqual(['postgres', '-c', 'max_connections=50']);
    expect(() => compose.service('nope')).toThrow('no service nope');
    expect(withDefaults('${X:-a}/${Y-b}/${Z}')).toBe('a/b/');
  });

  it('reads nginx directives, blocks, quoted strings, placeholders and times', () => {
    const directives = parseNginx(NGINX);

    expect(findDirectives(directives, 'server').map((server) => server.args)).toEqual([
      ['a:3000', 'resolve'],
      [],
    ]);
    expect(findDirectives(directives, 'limit_req')[0]?.args).toEqual([
      'zone=z',
      'burst=${BURST}',
      'nodelay',
    ]);
    const [map] = findDirectives(directives, 'map');
    expect(map?.block?.map((entry) => [entry.name, ...entry.args])).toEqual([
      ['', '$request_id'],
      ['default', '$http_x_id'],
    ]);
    expect(findDirectives(directives, 'return')[0]?.args).toEqual(['502', '{"a":"b;c","d":"$id"}']);
    const [timeout] = findDirectives(directives, 'proxy_read_timeout');
    expect(timeout?.parents.map((parent) => [parent.name, ...parent.args])).toEqual([
      ['server'],
      ['location', '/'],
    ]);
    expect(onlyArgument(directives, 'proxy_pass')).toBe('http://pool');
    expect(() => onlyArgument(directives, 'location')).toThrow();
    expect([nginxTimeMs('30s'), nginxTimeMs('1m'), nginxTimeMs('500ms'), nginxTimeMs('7')]).toEqual(
      [30_000, 60_000, 500, 7000],
    );
    expect(() => parseNginx('server {')).toThrow();
    expect(() => parseNginx('listen 80')).toThrow();
    expect(() => parseNginx("return 'open;")).toThrow();
  });

  it("finds the stack's services, published ports and timeouts in the repository's files", () => {
    const compose = readCompose();
    const template = readNginxTemplate();

    expect(compose.services.length).toBe(9);
    expect(compose.service('nginx').ports).toEqual([
      { hostIp: '127.0.0.1', hostPort: '8080', containerPort: '8080' },
    ]);
    expect(compose.replicas().map((replica) => replica.name)).toEqual(['api-1', 'api-2']);
    expect(nginxTimeMs(onlyArgument(template, 'proxy_read_timeout'))).toBe(30_000);
    expect(nginxTimeMs(onlyArgument(template, 'proxy_send_timeout'))).toBe(30_000);
  });
});
