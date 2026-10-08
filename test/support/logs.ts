/** One log line as the service writes it: a JSON object (SEC-R21). */
export type LogLine = Record<string, unknown> & { level?: number; msg?: string; reqId?: string };

/** pino's numeric levels. */
export const LOG_LEVEL = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

/**
 * Captures the log output of an app through the logger's destination stream (plan 000 section 9):
 * every write is kept as raw text, and `lines()` parses it.
 */
export class LogCapture {
  readonly #chunks: string[] = [];

  /** The destination stream to pass to the app. */
  readonly stream = {
    write: (chunk: string): void => {
      this.#chunks.push(chunk);
    },
  };

  /** Everything written so far, as one text. */
  text(): string {
    return this.#chunks.join('');
  }

  /** Every line written so far, each parsed as JSON; a line that is not JSON fails the test. */
  lines(): LogLine[] {
    return this.text()
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as LogLine);
  }

  /** The lines of one request. */
  linesOf(reqId: string): LogLine[] {
    return this.lines().filter((line) => line.reqId === reqId);
  }

  clear(): void {
    this.#chunks.length = 0;
  }
}
