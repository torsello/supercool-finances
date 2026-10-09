import { basename } from 'node:path';
import type { TestSpecification } from 'vitest/node';
import { BaseSequencer } from 'vitest/node';

/**
 * The order of the e2e files (plan 008 section 5, plan 007 section 6):
 *
 * 1. the files that need empty volumes, and DEP-AC01's fresh clone. `stack-support` proves the
 *    harness first; the seed runs before `migrations`, whose DEP-AC04 reads as the seeded
 *    demo-customer-1;
 * 2. every other e2e file, in name order, each restoring the replicas it stopped;
 * 3. SEC-AC05, which reads the responses of every file before it, then SEC-AC01, which floods the
 *    per-IP limit and so runs alone, last.
 */
export const FIRST = [
  'stack-support.test.ts',
  'stack-start.test.ts',
  'stack-failed-migration.test.ts',
  'seed.test.ts',
  'migrations.test.ts',
] as const;

export const LAST = ['no-rate-limited.test.ts', 'edge-rate-limit.test.ts'] as const;

/** Orders e2e file paths into the three groups; any other file goes to the second, by name. */
export function orderE2eFiles<T>(files: readonly T[], pathOf: (file: T) => string): T[] {
  const rank = (file: T): [number, number, string] => {
    const name = basename(pathOf(file));
    const first = (FIRST as readonly string[]).indexOf(name);
    if (first !== -1) return [0, first, name];
    const last = (LAST as readonly string[]).indexOf(name);
    if (last !== -1) return [2, last, name];
    return [1, 0, name];
  };
  return [...files].sort((left, right) => {
    const [groupA, indexA, nameA] = rank(left);
    const [groupB, indexB, nameB] = rank(right);
    return groupA - groupB || indexA - indexB || nameA.localeCompare(nameB);
  });
}

/**
 * Vitest's sequencer for every project: the unit and integration files keep Vitest's own order,
 * and the e2e files, which run one at a time, follow `orderE2eFiles` after them.
 */
export class E2eSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const e2e = files.filter((file) => file.project.name === 'e2e');
    const others = files.filter((file) => file.project.name !== 'e2e');
    return [...(await super.sort(others)), ...orderE2eFiles(e2e, (file) => file.moduleId)];
  }
}
