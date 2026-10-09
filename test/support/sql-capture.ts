import pg from 'pg';

/** One statement as a `pg` client sent it. */
export interface CapturedStatement {
  client: pg.Client;
  text: string;
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
      statements.push({ client: this, text: textOf(args[0]) });
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
