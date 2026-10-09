import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { loadConfig, type Config } from '../../src/platform/config/config.js';

/**
 * Reads the deployment definitions of the repository for the unit tests of plans 007 and 008
 * (plan 007 section 8): `compose.yaml`, with the `yaml` package, and the nginx configuration, with
 * a small parser of its directive syntax. Nothing here runs Docker, so `npm run check` needs none.
 */

/** The repository root. */
export const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function readRepositoryFile(path: string): string {
  return readFileSync(new URL(path, `file://${REPOSITORY_ROOT}`), 'utf8');
}

/** One port a service publishes on the host. */
export interface PublishedPort {
  /** The host address it is bound to; undefined when bound to every interface. */
  hostIp: string | undefined;
  hostPort: string | undefined;
  containerPort: string;
}

export interface DependsOn {
  condition: string;
}

export interface ComposeService {
  name: string;
  image: string | undefined;
  /** The build target, when the service is built from the Dockerfile. */
  buildTarget: string | undefined;
  /** The environment with every `${VAR:-default}` replaced by its default, as with VAR unset. */
  environment: Readonly<Record<string, string>>;
  /** The environment as written, interpolations included. */
  rawEnvironment: Readonly<Record<string, string>>;
  ports: readonly PublishedPort[];
  expose: readonly string[];
  dependsOn: Readonly<Record<string, DependsOn>>;
  profiles: readonly string[];
  stopGracePeriod: string | undefined;
  hasEnvFile: boolean;
  entrypoint: readonly string[] | undefined;
  command: readonly string[] | undefined;
  /** The service as parsed, YAML anchors and merge keys resolved. */
  raw: Readonly<Record<string, unknown>>;
}

export interface Compose {
  services: readonly ComposeService[];
  service(name: string): ComposeService;
  /** The services that run the API: those whose environment sets `REPLICA_ID` (DEP-R14). */
  replicas(): readonly ComposeService[];
  raw: Readonly<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error(`expected a scalar in compose.yaml, got ${JSON.stringify(value)}`);
}

/** Replaces each `${VAR:-default}` or `${VAR-default}` with its default, and `${VAR}` with "". */
export function withDefaults(value: string): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::?-([^}]*))?\}/g,
    (_match, _name: string, fallback: string | undefined) => fallback ?? '',
  );
}

function environmentOf(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((item) => {
        const text = asString(item);
        const equals = text.indexOf('=');
        return equals === -1 ? [text, ''] : [text.slice(0, equals), text.slice(equals + 1)];
      }),
    );
  }
  if (!isRecord(value)) throw new Error('environment must be a list or a map');
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, item === null ? '' : asString(item)]),
  );
}

/** A port of the short syntax (`[ip:]host:container`) or of the long syntax. */
function portOf(value: unknown): PublishedPort {
  if (isRecord(value)) {
    return {
      hostIp: value['host_ip'] === undefined ? undefined : asString(value['host_ip']),
      hostPort: value['published'] === undefined ? undefined : asString(value['published']),
      containerPort: asString(value['target']),
    };
  }
  const parts = asString(value).split('/')[0]?.split(':') ?? [];
  if (parts.length === 3) {
    return { hostIp: parts[0], hostPort: parts[1], containerPort: parts[2] ?? '' };
  }
  if (parts.length === 2)
    return { hostIp: undefined, hostPort: parts[0], containerPort: parts[1] ?? '' };
  return { hostIp: undefined, hostPort: undefined, containerPort: parts[0] ?? '' };
}

function dependsOnOf(value: unknown): Record<string, DependsOn> {
  if (value === undefined) return {};
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((name) => [asString(name), { condition: 'service_started' }]),
    );
  }
  if (!isRecord(value)) throw new Error('depends_on must be a list or a map');
  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [
      name,
      { condition: isRecord(item) ? asString(item['condition']) : 'service_started' },
    ]),
  );
}

function listOf(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(asString);
  return [asString(value)];
}

function serviceOf(name: string, value: unknown): ComposeService {
  if (!isRecord(value)) throw new Error(`service ${name} is not a map`);
  const rawEnvironment = environmentOf(value['environment']);
  const build = value['build'];
  return {
    name,
    image: value['image'] === undefined ? undefined : asString(value['image']),
    buildTarget:
      build === undefined
        ? undefined
        : isRecord(build) && build['target'] !== undefined
          ? asString(build['target'])
          : '',
    environment: Object.fromEntries(
      Object.entries(rawEnvironment).map(([key, item]) => [key, withDefaults(item)]),
    ),
    rawEnvironment,
    ports: (Array.isArray(value['ports']) ? value['ports'] : []).map(portOf),
    expose: listOf(value['expose']) ?? [],
    dependsOn: dependsOnOf(value['depends_on']),
    profiles: listOf(value['profiles']) ?? [],
    stopGracePeriod:
      value['stop_grace_period'] === undefined ? undefined : asString(value['stop_grace_period']),
    hasEnvFile: value['env_file'] !== undefined,
    entrypoint: listOf(value['entrypoint']),
    command: listOf(value['command']),
    raw: value,
  };
}

/** Parses a Compose file, resolving YAML anchors and `<<` merge keys as Compose does. */
export function parseCompose(text: string): Compose {
  const raw: unknown = parse(text, { merge: true });
  if (!isRecord(raw) || !isRecord(raw['services'])) throw new Error('no services in compose file');
  const services = Object.entries(raw['services']).map(([name, value]) => serviceOf(name, value));
  return {
    services,
    raw,
    service(name) {
      const found = services.find((service) => service.name === name);
      if (found === undefined) throw new Error(`no service ${name} in compose file`);
      return found;
    },
    replicas() {
      return services.filter((service) => service.rawEnvironment['REPLICA_ID'] !== undefined);
    },
  };
}

export function readCompose(): Compose {
  return parseCompose(readRepositoryFile('compose.yaml'));
}

/** One nginx directive, with its arguments as written (quotes removed) and its block, if any. */
export interface NginxDirective {
  name: string;
  args: readonly string[];
  block: readonly NginxDirective[] | undefined;
}

/** Splits nginx configuration text into words, quoted strings, `;`, `{` and `}`. */
function nginxTokens(text: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === '#') {
      while (index < text.length && text.charAt(index) !== '\n') index += 1;
    } else if (char === ';' || char === '{' || char === '}') {
      tokens.push(char);
      index += 1;
    } else if (char === '"' || char === "'") {
      let value = '';
      index += 1;
      while (index < text.length && text.charAt(index) !== char) {
        if (text.charAt(index) === '\\' && index + 1 < text.length) index += 1;
        value += text.charAt(index);
        index += 1;
      }
      if (index >= text.length) throw new Error('unterminated string in nginx configuration');
      index += 1;
      // Marks a quoted token, so a quoted ";" is never taken for the end of a directive.
      tokens.push(`\u0000${value}`);
    } else {
      let value = '';
      while (index < text.length && !/[\s;{}]/.test(text.charAt(index))) {
        // A variable in braces, nginx's `${name}` or the template's `${VAR}`, is part of the word.
        const end = text.startsWith('${', index) ? text.indexOf('}', index) : -1;
        const next = end === -1 ? index + 1 : end + 1;
        value += text.slice(index, next);
        index = next;
      }
      tokens.push(value);
    }
  }
  return tokens;
}

function unquote(token: string): string {
  return token.startsWith('\u0000') ? token.slice(1) : token;
}

/** Parses nginx configuration into its directives; `${VAR}` placeholders are kept as written. */
export function parseNginx(text: string): NginxDirective[] {
  const tokens = nginxTokens(text);
  let position = 0;
  const parseBlock = (nested: boolean): NginxDirective[] => {
    const directives: NginxDirective[] = [];
    while (position < tokens.length) {
      const name = tokens[position];
      if (name === '}') {
        if (!nested) throw new Error('unexpected } in nginx configuration');
        position += 1;
        return directives;
      }
      if (name === undefined || name === ';' || name === '{') {
        throw new Error(`unexpected ${String(name)} in nginx configuration`);
      }
      position += 1;
      const args: string[] = [];
      for (;;) {
        const token = tokens[position];
        if (token === undefined) throw new Error(`directive ${name} is not terminated`);
        position += 1;
        if (token === ';') {
          directives.push({ name: unquote(name), args, block: undefined });
          break;
        }
        if (token === '{') {
          directives.push({ name: unquote(name), args, block: parseBlock(true) });
          break;
        }
        if (token === '}') throw new Error(`directive ${name} is not terminated`);
        args.push(unquote(token));
      }
    }
    if (nested) throw new Error('unterminated block in nginx configuration');
    return directives;
  };
  return parseBlock(false);
}

/** A directive found anywhere in a configuration, with the blocks around it, outermost first. */
export interface FoundDirective extends NginxDirective {
  parents: readonly NginxDirective[];
}

/** Every directive named `name`, at any depth. */
export function findDirectives(
  directives: readonly NginxDirective[],
  name: string,
  parents: readonly NginxDirective[] = [],
): FoundDirective[] {
  return directives.flatMap((directive) => [
    ...(directive.name === name ? [{ ...directive, parents }] : []),
    ...(directive.block === undefined
      ? []
      : findDirectives(directive.block, name, [...parents, directive])),
  ]);
}

/** The template of the nginx server configuration, rendered by the image's envsubst step. */
export const NGINX_TEMPLATE_PATH = 'docker/nginx/templates/default.conf.template';
/** The main nginx configuration, which includes the rendered template inside `http`. */
export const NGINX_MAIN_PATH = 'docker/nginx/nginx.conf';

export function readNginxTemplate(): NginxDirective[] {
  return parseNginx(readRepositoryFile(NGINX_TEMPLATE_PATH));
}

export function readNginxMain(): NginxDirective[] {
  return parseNginx(readRepositoryFile(NGINX_MAIN_PATH));
}

const NGINX_UNITS_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** An nginx time such as `30s`, `1m` or `500ms`, in milliseconds; a bare number is seconds. */
export function nginxTimeMs(value: string): number {
  const match = /^([0-9]+)(ms|s|m|h|d)?$/.exec(value);
  if (match === null) throw new Error(`not an nginx time: ${value}`);
  return Number(match[1]) * (NGINX_UNITS_MS[match[2] ?? 's'] ?? 1000);
}

/** The single argument of the only directive `name` in `directives`, at any depth. */
export function onlyArgument(directives: readonly NginxDirective[], name: string): string {
  const found = findDirectives(directives, name);
  if (found.length !== 1 || found[0]?.args.length !== 1) {
    throw new Error(
      `expected exactly one ${name} with one argument, found ${String(found.length)}`,
    );
  }
  return found[0].args[0] ?? '';
}

/** The configuration a replica of `compose.yaml` loads, every unset variable at its default. */
export function replicaConfig(service: ComposeService): Config {
  return loadConfig(service.environment);
}

/** One deployment's request timeout against its load balancer's upstream timeout (SEC-R47). */
export interface RequestTimeoutCheck {
  replica: string;
  requestTimeoutMs: number;
  loadBalancerTimeoutMs: number;
  /** Empty when the request timeout is below the load balancer's; otherwise why not. */
  problems: string[];
}

/**
 * Compares each replica's `REQUEST_TIMEOUT_MS`, its default when unset, with nginx's
 * `proxy_read_timeout` in the location that proxies to the replicas (SEC-R34, SEC-R47).
 */
export function checkRequestTimeouts(
  compose: Compose,
  nginx: readonly NginxDirective[],
): RequestTimeoutCheck[] {
  const loadBalancerTimeoutMs = nginxTimeMs(onlyArgument(nginx, 'proxy_read_timeout'));
  return compose.replicas().map((replica) => {
    const { requestTimeoutMs } = replicaConfig(replica);
    return {
      replica: replica.name,
      requestTimeoutMs,
      loadBalancerTimeoutMs,
      problems:
        requestTimeoutMs < loadBalancerTimeoutMs
          ? []
          : [
              `${replica.name}: REQUEST_TIMEOUT_MS (${String(requestTimeoutMs)} ms) is not below nginx's proxy_read_timeout (${String(loadBalancerTimeoutMs)} ms)`,
            ],
    };
  });
}

/** PostgreSQL's defaults, used when the database service does not set them (SEC-AC29). */
const POSTGRES_MAX_CONNECTIONS = 100;
const POSTGRES_SUPERUSER_RESERVED_CONNECTIONS = 3;
/** Connections kept for migrations, scripts and manual sessions (section 1.9 of spec 007). */
export const RESERVED_CONNECTIONS = 10;

/** The connection budget of SEC-R36 for one deployment. */
export interface PoolBudget {
  replicas: number;
  dbPoolMax: number;
  maxConnections: number;
  superuserReservedConnections: number;
  /** replicas × (`DB_POOL_MAX` + 1) + 10. */
  needed: number;
  /** `max_connections` − `superuser_reserved_connections`. */
  available: number;
}

/** A `-c name=value` setting of the postgres command line, if the service sets one. */
function postgresSetting(service: ComposeService, name: string): number | undefined {
  const args = service.command ?? [];
  for (const [index, arg] of args.entries()) {
    const setting =
      arg === '-c' ? args[index + 1] : arg.startsWith('-c') ? arg.slice(2) : undefined;
    const match = setting === undefined ? null : /^([a-z_]+)=([0-9]+)$/.exec(setting);
    if (match?.[1] === name) return Number(match[2]);
  }
  return undefined;
}

/** Reads the connection budget of `compose.yaml` (SEC-R36). */
export function poolBudget(compose: Compose): PoolBudget {
  const replicas = compose.replicas();
  const pools = new Set(replicas.map((replica) => replicaConfig(replica).dbPoolMax));
  if (pools.size !== 1) throw new Error('the replicas set different DB_POOL_MAX values');
  const [dbPoolMax = 0] = pools;
  const postgres = compose.service('postgres');
  const maxConnections = postgresSetting(postgres, 'max_connections') ?? POSTGRES_MAX_CONNECTIONS;
  const superuserReservedConnections =
    postgresSetting(postgres, 'superuser_reserved_connections') ??
    POSTGRES_SUPERUSER_RESERVED_CONNECTIONS;
  return {
    replicas: replicas.length,
    dbPoolMax,
    maxConnections,
    superuserReservedConnections,
    needed: replicas.length * (dbPoolMax + 1) + RESERVED_CONNECTIONS,
    available: maxConnections - superuserReservedConnections,
  };
}
