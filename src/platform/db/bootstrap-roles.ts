import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * The one-time bootstrap of an AWS database (section 1.7 of spec 008, DEP-R38, DEP-R39): as the
 * RDS master user, create the owner and runtime roles of ADR-0018, set their passwords, grant the
 * runtime role to the owner role and give the database to the owner role, as
 * `docker/postgres/init/01-databases.sql` does locally. The master credentials serve nothing else.
 */

/** A role and the attributes it is created with. */
export interface RoleDeclaration {
  readonly name: string;
  readonly attributes: readonly string[];
}

/**
 * The roles as AWS gets them: each with only what the migrations and the service need. The owner
 * role needs `CREATEROLE` because PostgreSQL 16 lets only a role with it, and the admin option on
 * `scf_app`, run the `ALTER ROLE scf_app IN DATABASE ... SET` of the first migration (SEC-R29). The
 * local init script also gives it `CREATEDB` for the tests' scratch databases (DEP-AC30).
 */
export const BOOTSTRAP_ROLES = {
  owner: { name: 'scf_owner', attributes: ['LOGIN', 'CREATEROLE'] },
  runtime: { name: 'scf_app', attributes: ['LOGIN'] },
} as const satisfies Record<'owner' | 'runtime', RoleDeclaration>;

/**
 * The runtime role granted to the owner role: the admin option for that `ALTER ROLE`, and neither
 * inheritance nor `SET ROLE`, so the owner never acts with the runtime role's privileges.
 */
export const BOOTSTRAP_GRANT = {
  role: BOOTSTRAP_ROLES.runtime.name,
  member: BOOTSTRAP_ROLES.owner.name,
  admin: true,
  inherit: false,
  set: false,
} as const;

const SCRAM_ITERATIONS = 4096;

/**
 * The SCRAM-SHA-256 verifier of a password, in the form PostgreSQL stores (RFC 5802, RFC 7677):
 * `SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>`. PostgreSQL keeps a password given
 * in this form as it is, so the plaintext never reaches the server. The password must be printable
 * ASCII, which SASLprep leaves unchanged (DEP-R39).
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16)): string {
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${String(SCRAM_ITERATIONS)}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** The part of a database client the bootstrap uses; tests record what goes through it. */
export interface BootstrapClient {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
  end(): Promise<void>;
}

/** What one run did, printed as JSON (DEP-R38). */
export interface BootstrapReport {
  created: string[];
  passwordsSet: string[];
  grant: 'created' | 'unchanged';
  databaseOwner: 'set' | 'unchanged';
}

export interface BootstrapRoleNames {
  owner: string;
  runtime: string;
}

/**
 * A function of the session's temporary schema that sets a role's password from a bind parameter,
 * so the verifier never appears in a statement's text, which a server logging DDL would write out.
 * A failure is raised again with its SQLSTATE and a fixed message, because PostgreSQL would
 * otherwise put the dynamic statement, verifier included, in the error's context, which reaches the
 * server log and the client. It disappears with the session.
 */
const SET_PASSWORD_FUNCTION = `CREATE FUNCTION pg_temp.scf_bootstrap_set_password(role_name text, verifier text)
  RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER ROLE %I PASSWORD %L', role_name, verifier);
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION USING ERRCODE = SQLSTATE, MESSAGE = 'setting the password failed';
END
$$`;

function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function roleExists(client: BootstrapClient, name: string): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  return result.rowCount === 1;
}

/**
 * Applies the bootstrap in one transaction on a client connected as the master user: creates the
 * roles that do not exist, sets both passwords from their verifiers, grants the runtime role to the
 * owner role when it is not granted, and makes the owner role the owner of the current database.
 * Nothing is kept on any error.
 */
export async function bootstrapRoles(
  client: BootstrapClient,
  passwords: { owner: string; runtime: string },
  names: BootstrapRoleNames = {
    owner: BOOTSTRAP_ROLES.owner.name,
    runtime: BOOTSTRAP_ROLES.runtime.name,
  },
): Promise<BootstrapReport> {
  const roles = [
    { name: names.owner, attributes: BOOTSTRAP_ROLES.owner.attributes, password: passwords.owner },
    {
      name: names.runtime,
      attributes: BOOTSTRAP_ROLES.runtime.attributes,
      password: passwords.runtime,
    },
  ];
  await client.query('BEGIN');
  try {
    await client.query(SET_PASSWORD_FUNCTION);
    const created: string[] = [];
    for (const role of roles) {
      if (await roleExists(client, role.name)) continue;
      // The attributes are the constants above, never input.
      await client.query(`CREATE ROLE ${identifier(role.name)} WITH ${role.attributes.join(' ')}`);
      created.push(role.name);
    }
    for (const role of roles) {
      await client.query('SELECT pg_temp.scf_bootstrap_set_password($1, $2)', [
        role.name,
        scramSha256Verifier(role.password),
      ]);
    }

    const granted = await client.query(
      'SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole AND member = $2::regrole',
      [names.runtime, names.owner],
    );
    if (granted.rowCount === 0) {
      await client.query(
        `GRANT ${identifier(names.runtime)} TO ${identifier(names.owner)} WITH ADMIN ${String(BOOTSTRAP_GRANT.admin).toUpperCase()}, INHERIT ${String(BOOTSTRAP_GRANT.inherit).toUpperCase()}, SET ${String(BOOTSTRAP_GRANT.set).toUpperCase()}`,
      );
    }

    const owner = await client.query<{ owner: string; name: string }>(
      `SELECT pg_get_userbyid(datdba) AS owner, current_database() AS name
         FROM pg_database WHERE datname = current_database()`,
    );
    const database = owner.rows[0];
    const ownerChanged = database !== undefined && database.owner !== names.owner;
    if (ownerChanged) {
      // ALTER DATABASE ... OWNER TO needs SET on the new owner. The master user holds the admin
      // option on the roles it created, so it grants itself SET for this statement only and
      // revokes that grant before the commit.
      await client.query(
        `GRANT ${identifier(names.owner)} TO CURRENT_USER WITH SET TRUE, INHERIT FALSE`,
      );
      await client.query(
        `ALTER DATABASE ${identifier(database.name)} OWNER TO ${identifier(names.owner)}`,
      );
      await client.query(
        `REVOKE ${identifier(names.owner)} FROM CURRENT_USER GRANTED BY CURRENT_USER`,
      );
    }
    await client.query('COMMIT');
    return {
      created,
      passwordsSet: roles.map((role) => role.name),
      grant: granted.rowCount === 0 ? 'created' : 'unchanged',
      databaseOwner: ownerChanged ? 'set' : 'unchanged',
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

interface Output {
  write(text: string): unknown;
}

export interface BootstrapCommandOptions {
  env: Readonly<Record<string, string | undefined>>;
  stdout: Output;
  stderr: Output;
  /** Opens a client on a URL that holds the password; `pg.Client` by default. */
  connect?: (connectionString: string) => Promise<BootstrapClient>;
  /** The role names; `scf_owner` and `scf_app` unless a test gives its own. */
  roles?: BootstrapRoleNames;
}

/** Printable ASCII, `!` to `~`: SASLprep leaves such a password unchanged (DEP-R39). */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

class InputError extends Error {}

function read(
  env: BootstrapCommandOptions['env'],
  name: string,
  rule: string,
  valid: (value: string) => boolean = () => true,
): string {
  const value = env[name];
  if (value === undefined || value === '') throw new InputError(`${name} is not set`);
  if (!valid(value)) throw new InputError(`${name} must be ${rule}`);
  return value;
}

function isMasterUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
      url.username !== '' &&
      url.password === '' &&
      url.pathname.length > 1
    );
  } catch {
    return false;
  }
}

async function pgConnect(connectionString: string): Promise<BootstrapClient> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return client;
}

/** The SQLSTATE of a failed statement, also behind a wrapping error. */
function sqlStateOf(error: unknown): string | undefined {
  if (error instanceof pg.DatabaseError) return error.code;
  return error instanceof Error ? sqlStateOf(error.cause) : undefined;
}

/** The system error code of a connection failure, such as `ECONNREFUSED`, safe to print. */
function systemCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return code;
  return systemCodeOf(error.cause);
}

/**
 * `node dist/cli/bootstrap-roles.js` (DEP-R38, DEP-R39): reads `BOOTSTRAP_DATABASE_URL` (the master
 * user's URL to the instance, without a password), `PGPASSWORD`, `OWNER_ROLE_PASSWORD` and
 * `RUNTIME_ROLE_PASSWORD`, applies `bootstrapRoles` and prints its report as one JSON line, then
 * returns 0. On a missing or invalid variable it sends nothing; on any failure it prints one line
 * that names the variable, the SQLSTATE or the system error code, and never a password, a
 * verifier, the URL or a message of the server or the driver, and returns 1.
 */
export async function runBootstrapCommand(options: BootstrapCommandOptions): Promise<0 | 1> {
  const { env, stdout, stderr } = options;
  let connectionString: string;
  let passwords: { owner: string; runtime: string };
  try {
    const url = new URL(
      read(
        env,
        'BOOTSTRAP_DATABASE_URL',
        'a postgres:// URL with a user and a database and no password, which comes from PGPASSWORD',
        isMasterUrl,
      ),
    );
    const masterPassword = read(env, 'PGPASSWORD', 'set');
    const passwordRule = 'printable ASCII characters (! to ~) only';
    passwords = {
      owner: read(env, 'OWNER_ROLE_PASSWORD', passwordRule, (value) => PRINTABLE_ASCII.test(value)),
      runtime: read(env, 'RUNTIME_ROLE_PASSWORD', passwordRule, (value) =>
        PRINTABLE_ASCII.test(value),
      ),
    };
    url.password = encodeURIComponent(masterPassword);
    connectionString = url.toString();
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    stderr.write(`bootstrap: ${error.message}\n`);
    return 1;
  }

  let client: BootstrapClient | undefined;
  try {
    client = await (options.connect ?? pgConnect)(connectionString);
    const report = await bootstrapRoles(client, passwords, options.roles);
    stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
  } catch (error) {
    const sqlState = sqlStateOf(error);
    const code = systemCodeOf(error);
    stderr.write(
      sqlState !== undefined
        ? `bootstrap: a statement failed with SQLSTATE ${sqlState}; nothing was changed\n`
        : `bootstrap: the bootstrap failed (${error instanceof Error ? error.name : 'unknown error'}${code === undefined ? '' : `, ${code}`}); nothing was changed\n`,
    );
    return 1;
  } finally {
    await client?.end().catch(() => undefined);
  }
}
