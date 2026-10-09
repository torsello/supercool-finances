import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { loadConfig, type Config } from '../../src/platform/config/config.js';

/**
 * Reads the deployment definitions of the repository for the unit tests of plans 007 and 008
 * (plan 007 section 8): `compose.yaml`, with the `yaml` package, the nginx configuration, with a
 * small parser of its directive syntax, and the Terraform of `infra/terraform/`, with one of HCL's
 * structure. Nothing here runs Docker or Terraform, so `npm run check` needs neither.
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
  return budgetOf(replicas.length, dbPoolMax, maxConnections, superuserReservedConnections);
}

function budgetOf(
  replicas: number,
  dbPoolMax: number,
  maxConnections: number,
  superuserReservedConnections: number,
): PoolBudget {
  return {
    replicas,
    dbPoolMax,
    maxConnections,
    superuserReservedConnections,
    needed: replicas * (dbPoolMax + 1) + RESERVED_CONNECTIONS,
    available: maxConnections - superuserReservedConnections,
  };
}

/**
 * The Terraform of `infra/terraform/`, read for SEC-AC29 and SEC-AC36 (plan 007 section 8) with a
 * small parser of HCL's structure: blocks, and attributes kept as the text of their expression.
 * A setting is resolved by following `var.<name>` from a module to the argument the root
 * configuration passes it, and from the root to the variable's default, so the tests read the
 * values a plain apply would use. Nothing here runs Terraform.
 */

/** A body of HCL: its attributes, as written without comments, and its blocks in order. */
export interface HclBody {
  attributes: ReadonlyMap<string, string>;
  blocks: readonly HclBlock[];
}

export interface HclBlock {
  type: string;
  labels: readonly string[];
  body: HclBody;
}

/** Parses HCL text into its blocks and attributes; expressions are kept as text. */
export function parseHcl(text: string): HclBody {
  let position = 0;
  const at = (offset = 0): string => text.charAt(position + offset);

  /** Skips a comment at the position, if any; true when one was skipped. */
  const skipComment = (): boolean => {
    if (at() === '#' || (at() === '/' && at(1) === '/')) {
      while (position < text.length && at() !== '\n') position += 1;
      return true;
    }
    if (at() === '/' && at(1) === '*') {
      const end = text.indexOf('*/', position + 2);
      if (end === -1) throw new Error('unterminated comment in HCL');
      position = end + 2;
      return true;
    }
    return false;
  };

  const skipSpace = (newlines: boolean): void => {
    while (position < text.length) {
      if (at() === ' ' || at() === '\t' || at() === '\r' || (newlines && at() === '\n')) {
        position += 1;
      } else if (!skipComment()) {
        return;
      }
    }
  };

  /** Reads a quoted string at the position, `${...}` and `%{...}` templates included. */
  const readString = (): string => {
    const start = position;
    position += 1;
    while (position < text.length && at() !== '"') {
      if (at() === '\\') {
        position += 2;
      } else if ((at() === '$' || at() === '%') && at(1) === '{') {
        position += 2;
        readExpression('}');
        position += 1;
      } else {
        position += 1;
      }
    }
    if (position >= text.length) throw new Error('unterminated string in HCL');
    position += 1;
    return text.slice(start, position);
  };

  /** Reads a heredoc at the position (`<<EOT` or `<<-EOT`), through its closing line. */
  const readHeredoc = (): string => {
    const start = position;
    const match = /^<<-?([A-Za-z_][A-Za-z0-9_]*)\r?\n/.exec(text.slice(position));
    if (match === null) throw new Error('malformed heredoc in HCL');
    position += match[0].length;
    const marker = match[1] ?? '';
    for (;;) {
      const end = text.indexOf('\n', position);
      const line = text.slice(position, end === -1 ? text.length : end);
      position = end === -1 ? text.length : end + 1;
      if (line.trim() === marker) return text.slice(start, position);
      if (end === -1) throw new Error(`heredoc ${marker} is not closed`);
    }
  };

  /**
   * Reads an expression until a newline outside brackets, or until `closing` at depth 0, which is
   * left unread; comments are dropped from the text returned.
   */
  const readExpression = (closing?: string): string => {
    let expression = '';
    let depth = 0;
    while (position < text.length) {
      const char = at();
      if (depth === 0 && (char === '\n' || char === closing)) break;
      if (char === '}' && depth === 0) break;
      if (char === '"') {
        expression += readString();
      } else if (char === '<' && at(1) === '<' && /[-A-Za-z_]/.test(at(2))) {
        expression += readHeredoc();
      } else if (skipComment()) {
        expression += ' ';
      } else {
        if (char === '(' || char === '[' || char === '{') depth += 1;
        if (char === ')' || char === ']' || char === '}') depth -= 1;
        expression += char;
        position += 1;
      }
    }
    return expression.replace(/\s+/g, ' ').trim();
  };

  const readIdentifier = (): string => {
    const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(text.slice(position));
    if (match === null) {
      throw new Error(`unexpected ${JSON.stringify(at())} in HCL at offset ${String(position)}`);
    }
    position += match[0].length;
    return match[0];
  };

  const parseBody = (nested: boolean): HclBody => {
    const attributes = new Map<string, string>();
    const blocks: HclBlock[] = [];
    for (;;) {
      skipSpace(true);
      if (position >= text.length) {
        if (nested) throw new Error('unterminated block in HCL');
        return { attributes, blocks };
      }
      if (at() === '}') {
        if (!nested) throw new Error('unexpected } in HCL');
        position += 1;
        return { attributes, blocks };
      }
      const name = readIdentifier();
      skipSpace(false);
      if (at() === '=' && at(1) !== '=') {
        position += 1;
        skipSpace(false);
        attributes.set(name, readExpression());
        continue;
      }
      const labels: string[] = [];
      while (at() !== '{') {
        labels.push(at() === '"' ? readString().slice(1, -1) : readIdentifier());
        skipSpace(false);
      }
      position += 1;
      blocks.push({ type: name, labels, body: parseBody(true) });
    }
  };

  return parseBody(false);
}

/** The root configuration of the AWS deployment. */
export const TERRAFORM_ROOT = 'infra/terraform';

/** A Terraform module: its folder and every `.tf` file of it, merged. */
export interface TerraformModule {
  path: string;
  attributes: ReadonlyMap<string, string>;
  blocks: readonly HclBlock[];
}

/** The root module and the modules it calls by local path. */
export interface Terraform {
  root: TerraformModule;
  /** The module that the root's `module "<name>"` block calls. */
  module(name: string): TerraformModule;
}

function readTerraformModule(
  path: string,
  replacements: Readonly<Record<string, string>>,
): TerraformModule {
  const files = readdirSync(new URL(path, `file://${REPOSITORY_ROOT}`))
    .filter((name) => name.endsWith('.tf'))
    .sort();
  const bodies = files.map((name) => {
    const file = `${path}/${name}`;
    return parseHcl(replacements[file] ?? readRepositoryFile(file));
  });
  return {
    path,
    attributes: new Map(bodies.flatMap((body) => [...body.attributes])),
    blocks: bodies.flatMap((body) => body.blocks),
  };
}

/**
 * Reads `infra/terraform/` and the modules it calls; `replacements` maps a file's repository path
 * to the text read in its place, so a test can check a modified copy.
 */
export function readTerraform(replacements: Readonly<Record<string, string>> = {}): Terraform {
  const root = readTerraformModule(TERRAFORM_ROOT, replacements);
  return {
    root,
    module(name) {
      const call = findBlock(root, 'module', [name]);
      const source = /^"\.\/(.+)"$/.exec(call.body.attributes.get('source') ?? '')?.[1];
      if (source === undefined) throw new Error(`module ${name} is not called by a local path`);
      return readTerraformModule(`${TERRAFORM_ROOT}/${source}`, replacements);
    },
  };
}

/** The only block of a module with this type and these labels. */
export function findBlock(
  module: Pick<TerraformModule, 'blocks' | 'path'>,
  type: string,
  labels: readonly string[],
): HclBlock {
  const found = module.blocks.filter(
    (block) => block.type === type && labels.every((label, index) => block.labels[index] === label),
  );
  if (found.length !== 1) {
    throw new Error(
      `expected one ${type} ${labels.join(' ')} in ${module.path}, found ${String(found.length)}`,
    );
  }
  // Checked just above: exactly one block was found.
  return found[0] as HclBlock;
}

/** An attribute of a block, failing when the block does not set it. */
export function attributeOf(block: HclBlock, name: string): string {
  const value = block.body.attributes.get(name);
  if (value === undefined) {
    throw new Error(`${block.type} ${block.labels.join(' ')} does not set ${name}`);
  }
  return value;
}

/**
 * The literal value of an expression of `module`: a number or a string without interpolation,
 * `tostring(...)` of one, or `var.<name>`, followed to the argument the root passes the module
 * and, in the root, to the variable's default. Undefined when it is anything else.
 */
export function resolveTerraform(
  terraform: Terraform,
  module: TerraformModule,
  expression: string,
): string | undefined {
  const value = expression.trim();
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(value)) return value;
  const string = /^"([^"\\$%]*)"$/.exec(value);
  if (string !== null) return string[1];
  const call = /^tostring\((.*)\)$/.exec(value);
  if (call !== null) return resolveTerraform(terraform, module, call[1] ?? '');
  const variable = /^var\.([A-Za-z_][A-Za-z0-9_-]*)$/.exec(value)?.[1];
  if (variable === undefined) return undefined;
  if (module.path === TERRAFORM_ROOT) {
    const fallback = findBlock(module, 'variable', [variable]).body.attributes.get('default');
    return fallback === undefined ? undefined : resolveTerraform(terraform, module, fallback);
  }
  const calls = terraform.root.blocks.filter(
    (block) =>
      block.type === 'module' &&
      block.body.attributes.get('source') === `"./${module.path.slice(TERRAFORM_ROOT.length + 1)}"`,
  );
  if (calls.length !== 1) throw new Error(`expected one call of ${module.path}`);
  // Checked just above: exactly one call.
  const argument = (calls[0] as HclBlock).body.attributes.get(variable);
  return argument === undefined ? undefined : resolveTerraform(terraform, terraform.root, argument);
}

/** A literal number of the Terraform, failing when the expression does not resolve to one. */
function resolveNumber(terraform: Terraform, module: TerraformModule, expression: string): number {
  const value = resolveTerraform(terraform, module, expression);
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    throw new Error(`${expression} in ${module.path} does not resolve to a whole number`);
  }
  return Number(value);
}

/**
 * Variables of the api container that its task definition takes from Secrets Manager or builds
 * from other resources; they are given placeholders so the configuration loader can run.
 */
const TERRAFORM_PLACEHOLDERS: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgres://scf_app@proxy.invalid:5432/supercool?sslmode=verify-full',
  REDIS_URL: 'rediss://:placeholder@redis.invalid:6379',
  JWT_SECRET: 'placeholder-jwt-secret-for-the-terraform-check-000',
  CURSOR_SECRET: 'placeholder-cursor-secret-for-the-terraform-check',
  JWT_ISSUER: 'https://auth.invalid/',
  JWT_AUDIENCE: 'supercool-finances-api',
  PGPASSWORD: 'placeholder',
};

/** The variables of the connection and timeout budgets of SEC-AC29 and SEC-AC36. */
const BUDGET_VARIABLE = /^(DB_POOL_MAX|[A-Z_]*_TIMEOUT_MS|SHUTDOWN_DRAIN_DELAY_MS)$/;

/**
 * The configuration the service's api container loads in AWS: the variables of its task
 * definition that resolve to literals, every other one at its default. A variable of the budgets
 * (`DB_POOL_MAX`, a timeout or the drain delay) that does not resolve fails the read instead.
 */
export function terraformApiConfig(terraform: Terraform): Config {
  const service = terraform.module('service');
  const locals = service.blocks.filter((block) => block.type === 'locals');
  const container = locals
    .map((block) => block.body.attributes.get('api_container'))
    .find((value) => value !== undefined);
  if (container === undefined) throw new Error('the service module defines no api_container');
  const environment: Record<string, string> = {};
  // Each entry of the container's `environment` list, as `{ name = "X", value = <expression> }`.
  const environmentList = /\benvironment = \[(.*?)\] (?:secrets|logConfiguration) =/.exec(
    container,
  )?.[1];
  if (environmentList === undefined) throw new Error('the api container has no environment list');
  const read = new Set<string>();
  for (const entry of environmentList.matchAll(
    /\{ name = "([A-Z0-9_]+)", value = ("(?:\\.|[^"\\])*"|[^,}]+?) \}/g,
  )) {
    const name = entry[1] ?? '';
    read.add(name);
    const value = resolveTerraform(terraform, service, entry[2] ?? '');
    if (value !== undefined) environment[name] = value;
    // A budget setting the checks cannot read would fall back to its default unnoticed.
    else if (BUDGET_VARIABLE.test(name)) {
      throw new Error(
        `the api container sets ${name} to ${entry[2] ?? ''}, which does not resolve to a literal`,
      );
    }
  }
  for (const mention of environmentList.matchAll(/name = "([A-Z0-9_]+)"/g)) {
    const name = mention[1] ?? '';
    if (BUDGET_VARIABLE.test(name) && !read.has(name)) {
      throw new Error(`the api container sets ${name} in a form the checks cannot read`);
    }
  }
  return loadConfig({ ...TERRAFORM_PLACEHOLDERS, ...environment });
}

/**
 * The connection budget of SEC-R36 for the AWS deployment, a deployment's surge included: a
 * rollout at the autoscaling maximum runs max_capacity × deployment_maximum_percent / 100 tasks.
 */
export function terraformPoolBudget(terraform: Terraform): PoolBudget {
  const service = terraform.module('service');
  const scaling = findBlock(service, 'resource', ['aws_appautoscaling_target', 'api']);
  const maxTasks = resolveNumber(terraform, service, attributeOf(scaling, 'max_capacity'));
  const ecsService = findBlock(service, 'resource', ['aws_ecs_service', 'api']);
  const surgePercent = resolveNumber(
    terraform,
    service,
    attributeOf(ecsService, 'deployment_maximum_percent'),
  );
  const replicas = Math.floor((maxTasks * surgePercent) / 100);
  const { dbPoolMax } = terraformApiConfig(terraform);

  const database = terraform.module('database');
  const instance = findBlock(database, 'resource', ['aws_db_instance', 'this']);
  const group = /^aws_db_parameter_group\.([A-Za-z0-9_-]+)\.name$/.exec(
    attributeOf(instance, 'parameter_group_name'),
  )?.[1];
  if (group === undefined)
    throw new Error('the RDS instance names no parameter group of its module');
  const parameters = findBlock(database, 'resource', ['aws_db_parameter_group', group])
    .body.blocks.filter((block) => block.type === 'parameter')
    .map((block) => ({
      name: resolveTerraform(terraform, database, attributeOf(block, 'name')),
      value: attributeOf(block, 'value'),
    }));
  const parameter = (name: string, fallback: number): number => {
    const found = parameters.find((item) => item.name === name);
    return found === undefined ? fallback : resolveNumber(terraform, database, found.value);
  };
  return budgetOf(
    replicas,
    dbPoolMax,
    parameter('max_connections', POSTGRES_MAX_CONNECTIONS),
    parameter('superuser_reserved_connections', POSTGRES_SUPERUSER_RESERVED_CONNECTIONS),
  );
}

/** `REQUEST_TIMEOUT_MS` of the api container against the ALB's idle timeout (SEC-R47). */
export function checkTerraformRequestTimeout(terraform: Terraform): RequestTimeoutCheck {
  const { requestTimeoutMs } = terraformApiConfig(terraform);
  const edge = terraform.module('edge');
  const loadBalancer = findBlock(edge, 'resource', ['aws_lb', 'this']);
  const loadBalancerTimeoutMs =
    resolveNumber(terraform, edge, attributeOf(loadBalancer, 'idle_timeout')) * 1000;
  return {
    replica: 'aws:api',
    requestTimeoutMs,
    loadBalancerTimeoutMs,
    problems:
      requestTimeoutMs < loadBalancerTimeoutMs
        ? []
        : [
            `aws:api: REQUEST_TIMEOUT_MS (${String(requestTimeoutMs)} ms) is not below the ALB's idle timeout (${String(loadBalancerTimeoutMs)} ms)`,
          ],
  };
}
