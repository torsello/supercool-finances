import { beforeEach } from 'vitest';

// npm run trace counts a passing test as proof of the AC it names, but a test marked fails passes
// only when its body fails, and Vitest's report cannot tell the two apart. So any such test fails
// here, whatever the syntax that marked it: .fails, a fails option, a suite's options, an
// extended test. The flag is cleared first: with it set, Vitest would turn this error into a pass.
beforeEach(({ task }) => {
  if (task.fails === true) {
    // Vitest types the flag as read-only, but the runner reads it only after the test ends, so
    // clearing it here is what makes the error below count as a failure.
    (task as { fails?: boolean }).fails = false;
    throw new Error(
      'Tests marked fails are forbidden: they pass when their body fails, so they cannot prove an AC.',
    );
  }
});
