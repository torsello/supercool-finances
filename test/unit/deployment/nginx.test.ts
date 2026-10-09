import { BlockList } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../../src/app.js';
import { loadConfig } from '../../../src/platform/config/config.js';
import { PROBLEM_TYPES } from '../../../src/platform/http/problem.js';
import {
  findDirectives,
  NGINX_MAIN_PATH,
  nginxTimeMs,
  onlyArgument,
  parseCompose,
  readNginxMain,
  readCompose,
  readNginxTemplate,
  readRepositoryFile,
  withDefaults,
  type FoundDirective,
  type NginxDirective,
} from '../../support/deployment.js';
import { LogCapture } from '../../support/logs.js';

/** The location that proxies to the replicas. */
function proxyLocation(template: readonly NginxDirective[]): FoundDirective {
  const [location, ...others] = findDirectives(template, 'location').filter(
    (directive) => findDirectives(directive.block ?? [], 'proxy_pass').length > 0,
  );
  if (location === undefined || others.length > 0) throw new Error('expected one proxy location');
  return location;
}

/** The directives of a block, by name. */
function inBlock(block: readonly NginxDirective[] | undefined, name: string): NginxDirective[] {
  return (block ?? []).filter((directive) => directive.name === name);
}

/** The named location `error_page <status>` sends nginx's own error to, in the server on 8080. */
function errorLocation(template: readonly NginxDirective[], status: number): NginxDirective {
  const server = findDirectives(template, 'server').find((directive) =>
    inBlock(directive.block, 'listen').some((listen) => listen.args[0] === '8080'),
  );
  const page = inBlock(server?.block, 'error_page').find((directive) =>
    directive.args
      .filter((arg) => !arg.startsWith('='))
      .slice(0, -1)
      .includes(String(status)),
  );
  const target = page?.args.at(-1);
  const location = inBlock(server?.block, 'location').find(
    (directive) => directive.args.filter((arg) => arg !== '=')[0] === target,
  );
  if (location === undefined) throw new Error(`no error_page location for ${String(status)}`);
  return location;
}

interface Answer {
  status: number;
  contentType: string | undefined;
  headers: Record<string, { value: string | undefined; always: boolean }>;
  body: unknown;
}

/** What a named error location answers, with the request id variable replaced by `id`. */
function answer(location: NginxDirective, id: string): Answer {
  const [ret] = inBlock(location.block, 'return');
  const headers: Answer['headers'] = Object.fromEntries(
    inBlock(location.block, 'add_header').map((header): [string, Answer['headers'][string]] => [
      header.args[0] ?? '',
      { value: header.args[1], always: header.args[2] === 'always' },
    ]),
  );
  return {
    status: Number(ret?.args[0]),
    contentType: inBlock(location.block, 'default_type')[0]?.args[0],
    headers,
    body: JSON.parse((ret?.args[1] ?? '').replaceAll('$scf_problem_request_id', id)) as unknown,
  };
}

/** nginx's fixed address on the scf network, and the network's subnet and dynamic range. */
function nginxAddress(): { address: string; subnet: string; ipRange: string } {
  const compose = readCompose();
  const networks = compose.service('nginx').raw['networks'] as
    Record<string, { ipv4_address?: string } | null> | undefined;
  const network = (compose.raw['networks'] as Record<string, unknown> | undefined)?.['scf'] as
    { ipam?: { config?: { subnet?: string; ip_range?: string }[] } } | undefined;
  const [config] = network?.ipam?.config ?? [];
  // As with SCF_SUBNET_PREFIX unset: its default.
  return {
    address: withDefaults(networks?.['scf']?.ipv4_address ?? ''),
    subnet: withDefaults(config?.subnet ?? ''),
    ipRange: withDefaults(config?.ip_range ?? ''),
  };
}

function inBlockList(address: string, cidr: string): boolean {
  const [network = '', prefix = ''] = cidr.split('/');
  const list = new BlockList();
  list.addSubnet(network, Number(prefix), 'ipv4');
  return list.check(address, 'ipv4');
}

describe('the nginx configuration', () => {
  const logs = new LogCapture();
  // A replica of compose.yaml, with TRUSTED_PROXY_CIDRS as committed; the pool and Redis connect
  // lazily, so it reaches neither.
  const replica = buildApp(
    loadConfig({
      ...readCompose().service('api-1').environment,
      DATABASE_URL: 'postgres://scf_app:unused@127.0.0.1:1/unused',
      REDIS_URL: 'redis://127.0.0.1:1',
    }),
    { logStream: logs.stream },
  );

  afterAll(async () => {
    await replica.close();
  });

  it("SEC-R18 SEC-R19 the replicas trust X-Forwarded-For only from nginx's fixed address, so a client calling a replica directly cannot set its own address", async () => {
    const { address, subnet, ipRange } = nginxAddress();

    expect(address).toBe('10.210.0.10');
    expect(inBlockList(address, subnet)).toBe(true);
    // No other container can be given nginx's address: dynamic addresses come from ip_range.
    expect(inBlockList(address, ipRange)).toBe(false);
    const compose = readCompose();
    for (const name of ['api-1', 'api-2']) {
      expect(compose.service(name).environment['TRUSTED_PROXY_CIDRS'], name).toBe(`${address}/32`);
    }
    // One prefix moves the subnet, nginx's address, the range and the trusted block together.
    const raw = readRepositoryFile('compose.yaml');
    expect(raw.match(/\$\{SCF_SUBNET_PREFIX:-10\.210\.0\}/g)).toHaveLength(8);
    expect(raw).not.toMatch(/(?<!-)10\.210\.0\./);
    const moved = parseCompose(raw.replaceAll('${SCF_SUBNET_PREFIX:-10.210.0}', '172.31.250'));
    expect(moved.service('api-1').environment['TRUSTED_PROXY_CIDRS']).toBe('172.31.250.10/32');

    // Through nginx, the address nginx forwards is the client's; from any other peer on the
    // network, such as the gateway a request to 127.0.0.1:3001 arrives from, the header is ignored.
    for (const [peer, id] of [
      [address, 'via-nginx'],
      ['10.210.0.128', 'via-gateway'],
      ['10.210.0.131', 'via-container'],
    ] as const) {
      await replica.inject({
        method: 'GET',
        url: '/health/live',
        remoteAddress: peer,
        headers: { 'x-forwarded-for': '6.6.6.6', 'x-request-id': id },
      });
    }
    const clientOf = (id: string): unknown => {
      const line = logs.linesOf(id).find((item) => item['req'] !== undefined);
      return (line?.['req'] as { remoteAddress?: unknown } | undefined)?.remoteAddress;
    };
    expect(clientOf('via-nginx')).toBe('6.6.6.6');
    expect(clientOf('via-gateway')).toBe('10.210.0.128');
    expect(clientOf('via-container')).toBe('10.210.0.131');
  });

  it('DEP-R15 balances round robin over both replicas with keep-alive, at their fixed addresses and never re-resolved, so a failed request can always be passed to the other one', () => {
    const template = readNginxTemplate();

    const [upstream, ...others] = findDirectives(template, 'upstream');
    expect(others).toEqual([]);
    expect(upstream?.args).toEqual(['scf_api']);
    // No `resolve`: a re-resolution that changes the servers during a request makes nginx skip
    // the retry on the other replica, so the servers are fixed addresses.
    expect(inBlock(upstream?.block, 'server').map((server) => server.args)).toEqual([
      ['${API_1_ADDRESS}:3000'],
      ['${API_2_ADDRESS}:3000'],
    ]);
    expect(findDirectives(template, 'resolver')).toEqual([]);
    const compose = readCompose();
    const { subnet, ipRange } = nginxAddress();
    const nginx = compose.service('nginx').environment;
    for (const [variable, replica] of [
      ['API_1_ADDRESS', 'api-1'],
      ['API_2_ADDRESS', 'api-2'],
    ] as const) {
      const networks = compose.service(replica).raw['networks'] as
        Record<string, { ipv4_address?: string } | null> | undefined;
      const address = withDefaults(networks?.['scf']?.ipv4_address ?? '');
      expect(address, replica).toMatch(/^10\.210\.0\.1[12]$/);
      // Inside the subnet and outside ip_range, so no other container can take it.
      expect(inBlockList(address, subnet), replica).toBe(true);
      expect(inBlockList(address, ipRange), replica).toBe(false);
      expect(nginx[variable], variable).toBe(address);
    }
    // No balancing method other than the default round robin.
    for (const method of ['least_conn', 'ip_hash', 'hash', 'random']) {
      expect(inBlock(upstream?.block, method), method).toEqual([]);
    }
    expect(inBlock(upstream?.block, 'zone')).toHaveLength(1);
    expect(inBlock(upstream?.block, 'keepalive')).toHaveLength(1);
    expect(findDirectives(proxyLocation(template).block ?? [], 'proxy_pass')[0]?.args).toEqual([
      'http://scf_api',
    ]);
    // Upstream keep-alive needs HTTP/1.1 without "Connection: close".
    const location = proxyLocation(template).block;
    expect(inBlock(location, 'proxy_http_version')[0]?.args).toEqual(['1.1']);
    expect(inBlock(location, 'proxy_set_header').map((header) => header.args)).toContainEqual([
      'Connection',
      '',
    ]);

    // One worker, so the round robin alternates strictly, with a comment saying why.
    expect(onlyArgument(readNginxMain(), 'worker_processes')).toBe('1');
    const main = readRepositoryFile(NGINX_MAIN_PATH);
    const comment = main.slice(0, main.indexOf('worker_processes 1;'));
    expect(comment).toContain('DEP-R15');
    expect(comment).toMatch(/round.robin/);
  });

  it('DEP-R15 retries another replica only on a connection error or a timeout, once, and never a POST already sent', () => {
    const location = proxyLocation(readNginxTemplate()).block;

    expect(inBlock(location, 'proxy_next_upstream').map((directive) => directive.args)).toEqual([
      ['error', 'timeout'],
    ]);
    expect(
      inBlock(location, 'proxy_next_upstream_tries').map((directive) => directive.args),
    ).toEqual([['2']]);
    // A replica that is gone is given up on after 2 s, so the other one gets the request in
    // time (section 1.7 of spec 007).
    expect(inBlock(location, 'proxy_connect_timeout').map((directive) => directive.args)).toEqual([
      ['2s'],
    ]);
    expect(nginxTimeMs(onlyArgument(readNginxTemplate(), 'proxy_connect_timeout'))).toBe(2000);
  });

  it('DEP-R16 answers its own 502, 503 and 504 as problem details of type upstream-unavailable, with Retry-After: 1 and the request id in the header and the body', () => {
    const template = readNginxTemplate();

    for (const status of [502, 503, 504]) {
      const reply = answer(errorLocation(template, status), 'gw-1');

      expect(reply.status).toBe(status);
      expect(reply.contentType).toBe('application/problem+json');
      expect(reply.headers).toEqual({
        'X-Request-Id': { value: '$scf_problem_request_id', always: true },
        'Retry-After': { value: '1', always: true },
      });
      expect(reply.body).toEqual({
        type: '/problems/upstream-unavailable',
        title: 'Upstream Unavailable',
        status,
        detail: expect.any(String) as unknown,
        requestId: 'gw-1',
      });
    }
    // The service's own 5xx pass through unchanged.
    expect(findDirectives(template, 'proxy_intercept_errors')).toEqual([]);
  });

  it('SEC-R01 SEC-R02 limits each client IP by its TCP address, answering 429 problem details with Retry-After: 1', () => {
    const template = readNginxTemplate();

    expect(findDirectives(template, 'limit_req_zone').map((directive) => directive.args)).toEqual([
      ['$binary_remote_addr', 'zone=per_ip:10m', 'rate=${RATE_LIMIT_IP_RPS}r/s'],
    ]);
    expect(findDirectives(template, 'limit_req').map((directive) => directive.args)).toEqual([
      ['zone=per_ip', 'burst=${RATE_LIMIT_IP_BURST}', 'nodelay'],
    ]);
    expect(onlyArgument(template, 'limit_req_status')).toBe('429');
    const reply = answer(errorLocation(template, 429), 'rl-1');
    expect(reply.status).toBe(429);
    expect(reply.contentType).toBe('application/problem+json');
    expect(reply.headers['Retry-After']).toEqual({ value: '1', always: true });
    expect(reply.headers['X-Request-Id']).toEqual({
      value: '$scf_problem_request_id',
      always: true,
    });
    expect(reply.body).toEqual({
      type: '/problems/rate-limited',
      title: 'Rate Limited',
      status: 429,
      detail: 'Too many requests; retry after the number of seconds in Retry-After.',
      requestId: 'rl-1',
    });
  });

  it('SYS-R24 answers the requests its own parser refuses (400, 408, 414, 494) as 400 problem details of type malformed-request, and its own 404 as not-found, with the request id', () => {
    const template = readNginxTemplate();
    const pages = findDirectives(template, 'error_page').filter((page) =>
      page.args.includes('/_nginx/malformed-request'),
    );
    expect(pages.map((page) => page.args)).toEqual([
      ['400', '408', '414', '494', '=400', '/_nginx/malformed-request'],
    ]);
    // An internal URI location, which a request with an unparsed request line can reach, unlike a
    // named location; no client request can reach it directly.
    const location = errorLocation(template, 414);
    expect(location.args).toEqual(['=', '/_nginx/malformed-request']);
    expect(inBlock(location.block, 'internal')).toHaveLength(1);

    const reply = answer(location, 'bad-1');
    expect(reply.status).toBe(400);
    expect(reply.contentType).toBe('application/problem+json');
    expect(reply.headers).toEqual({
      'X-Request-Id': { value: '$scf_problem_request_id', always: true },
    });
    // The title and detail of the service's own malformed-request problem (SYS-R05).
    expect(reply.body).toEqual({
      type: '/problems/malformed-request',
      title: PROBLEM_TYPES['/problems/malformed-request'].title,
      status: 400,
      detail: PROBLEM_TYPES['/problems/malformed-request'].detail,
      requestId: 'bad-1',
    });

    // Requested directly, the internal location is nginx's own 404, answered as the service's.
    const notFound = answer(errorLocation(template, 404), 'nf-1');
    expect(notFound.status).toBe(404);
    expect(notFound.contentType).toBe('application/problem+json');
    expect(notFound.body).toEqual({
      type: '/problems/not-found',
      title: PROBLEM_TYPES['/problems/not-found'].title,
      status: 404,
      detail: PROBLEM_TYPES['/problems/not-found'].detail,
      requestId: 'nf-1',
    });
  });

  it('SEC-R13 SEC-R15 passes bodies up to 32 KB, answers larger ones with 413 problem details, and sends no version', () => {
    const template = readNginxTemplate();

    expect(onlyArgument(template, 'client_max_body_size')).toBe('32k');
    expect(onlyArgument(template, 'server_tokens')).toBe('off');
    const reply = answer(errorLocation(template, 413), 'big-1');
    expect(reply.status).toBe(413);
    expect(reply.contentType).toBe('application/problem+json');
    expect(reply.body).toEqual({
      type: '/problems/payload-too-large',
      title: 'Payload Too Large',
      status: 413,
      detail: 'The request body is larger than 16384 bytes.',
      requestId: 'big-1',
    });
  });

  it('SEC-R19 SEC-R20 SEC-R46 replaces X-Forwarded-For, forwards the request id, and logs the path without the query string', () => {
    const template = readNginxTemplate();
    const headers = inBlock(proxyLocation(template).block, 'proxy_set_header').map(
      (header) => header.args,
    );

    expect(headers).toContainEqual(['X-Forwarded-For', '$remote_addr']);
    expect(headers).toContainEqual(['X-Request-Id', '$scf_request_id']);
    const maps = findDirectives(template, 'map');
    const forwarded = maps.find((map) => map.args[1] === '$scf_request_id');
    expect(forwarded?.args[0]).toBe('$http_x_request_id');
    expect(forwarded?.block?.map((entry) => [entry.name, ...entry.args])).toEqual([
      ['', '$request_id'],
      ['default', '$http_x_request_id'],
    ]);

    const [format] = findDirectives(template, 'log_format');
    expect(format?.args.slice(0, 2)).toEqual(['scf', 'escape=json']);
    const line = format?.args.slice(2).join('') ?? '';
    expect(line).toContain('"path":"$uri"');
    expect(line).toContain('"requestId":"$scf_request_id"');
    expect(line).toContain('"responseRequestId":"$sent_http_x_request_id"');
    for (const withQuery of ['$request_uri', '$request"', '$args', '$query_string', '$is_args']) {
      expect(line).not.toContain(withQuery);
    }
    const logs = findDirectives(template, 'access_log').filter((log) => log.args[0] !== 'off');
    expect(logs.map((log) => log.args)).toEqual([['/var/log/nginx/access.log', 'scf']]);
    expect(findDirectives(readNginxMain(), 'access_log')).toEqual([]);
    expect(findDirectives(readNginxMain(), 'log_format')).toEqual([]);
  });
});
