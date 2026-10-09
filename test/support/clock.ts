import type { Timers } from '../../src/platform/http/request-timeout.js';

/** Lets every pending promise callback and immediate run, so effects of a step are visible. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * An injected clock for unit tests: time moves only through `advanceTo`, which fires every timer
 * due on the way, in order, and lets the promise callbacks of each one run before the next.
 */
export class FakeClock implements Timers {
  #now = 0;
  #next = 1;
  readonly #timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(callback: () => void, ms: number): number {
    const id = this.#next;
    this.#next += 1;
    this.#timers.set(id, { at: this.#now + Math.max(0, ms), callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.#timers.delete(handle);
  }

  async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.setTimeout(resolve, ms);
    });
  }

  /** Moves time to `at`, firing every timer due by then. */
  async advanceTo(at: number): Promise<void> {
    await settle();
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= at)
        .sort(([idA, a], [idB, b]) => a.at - b.at || idA - idB)[0];
      if (due === undefined) break;
      const [id, timer] = due;
      this.#timers.delete(id);
      this.#now = timer.at;
      timer.callback();
      await settle();
    }
    this.#now = at;
    await settle();
  }
}
