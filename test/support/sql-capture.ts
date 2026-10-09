import pg from 'pg';

/** One statement as a `pg` client sent it, with its parameter values. */
export interface CapturedStatement {
  client: pg.Client;
  text: string;
  values: unknown[];
}

type Query = (this: pg.Client, ...args: unknown[]) => unknown;

/** The text of the first argument of `query`: a string, or a query config with `text`. */
function textOf(argument: unknown): string {
  if (typeof argument === 'string') return argument;
  if (typeof argument === 'object' && argument !== null && 'text' in argument) {
    return String(argument.text);
  }
  return String(argument);
}

/** The parameter values of a `query` call: its second argument, or a query config's `values`. */
function valuesOf(argument: unknown, second: unknown): unknown[] {
  if (Array.isArray(second)) return second as unknown[];
  if (typeof argument === 'object' && argument !== null && 'values' in argument) {
    return Array.isArray(argument.values) ? (argument.values as unknown[]) : [];
  }
  return [];
}

/**
 * Records every statement any `pg` client of this test process sends, in order, with the client
 * that sent it, by wrapping `pg.Client.prototype.query` while started (plan 000 section 9). It is
 * test wiring around the driver, not a seam of the app: the app's pool, the readiness connection
 * and Kysely all send through that method.
 */
export class SqlCapture {
  readonly statements: CapturedStatement[] = [];
  #original: Query | undefined;

  start(): void {
    if (this.#original !== undefined) throw new Error('the capture is already started');
    const prototype = pg.Client.prototype as unknown as { query: Query };
    const original = prototype.query;
    this.#original = original;
    const statements = this.statements;
    prototype.query = function (this: pg.Client, ...args: unknown[]): unknown {
      statements.push({ client: this, text: textOf(args[0]), values: valuesOf(args[0], args[1]) });
      return original.apply(this, args);
    };
  }

  stop(): void {
    if (this.#original === undefined) return;
    (pg.Client.prototype as unknown as { query: Query }).query = this.#original;
    this.#original = undefined;
  }

  /** The texts recorded so far, in order. */
  texts(): string[] {
    return this.statements.map((statement) => statement.text);
  }

  /** Forgets what was recorded, keeping the capture running. */
  clear(): void {
    this.statements.length = 0;
  }
}
