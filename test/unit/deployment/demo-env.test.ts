import { describe, expect, it } from 'vitest';
import { verifyToken } from '../../../src/modules/auth/index.js';
import { DEMO_SECRETS } from '../../../src/platform/config/config.js';
import { runDemoEnv, type DemoEnvSeed } from '../../../scripts/demo-env.js';
import { readRepositoryFile } from '../../support/deployment.js';

/** The token settings of compose.yaml. */
const ENV = {
  JWT_SECRET: DEMO_SECRETS.JWT_SECRET,
  JWT_ISSUER: 'supercool-finances-local',
  JWT_AUDIENCE: 'supercool-finances-api',
};
const SETTINGS = { secret: ENV.JWT_SECRET, issuer: ENV.JWT_ISSUER, audience: ENV.JWT_AUDIENCE };

const NOW_MS = 1_791_500_000_000;
const A = '01a120ee-7169-72b0-8d38-000000000001';
const B = '01a120ee-7197-70bc-b40c-000000000002';

/** The seed's JSON for table 1.2 of spec 008, with the two EUR ids above. */
function seedOutput(withB = true): string {
  const users = [
    {
      name: 'demo-operator',
      id: '0192f0a0-0000-7000-8000-00000000d0f1',
      role: 'operator',
      accounts: [],
    },
    {
      name: 'demo-customer-1',
      id: '0192f0a0-0000-7000-8000-00000000d0c1',
      role: 'customer',
      accounts: [
        { id: A, currency: 'EUR', balance: '250000' },
        { id: '01a120ee-7184-7595-9e04-e47a18069d06', currency: 'USD', balance: '100000' },
      ],
    },
    {
      name: 'demo-customer-2',
      id: '0192f0a0-0000-7000-8000-00000000d0c2',
      role: 'customer',
      accounts: withB ? [{ id: B, currency: 'EUR', balance: '50000' }] : [],
    },
  ];
  return `${JSON.stringify({ users }, null, 2)}\n`;
}

function capture(): { write(text: string): boolean; text: string } {
  return {
    text: '',
    write(text) {
      this.text += text;
      return true;
    },
  };
}

async function run(seed: DemoEnvSeed) {
  const stdout = capture();
  const stderr = capture();
  const code = await runDemoEnv({ seed, env: ENV, now: () => NOW_MS, stdout, stderr });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

describe('make demo-env', () => {
  it('DEP-AC36 prints the four assignments of the Quickstart, and nothing on a failed, incomplete or malformed seed', async () => {
    const ok = await run(async (stdout) => {
      stdout.write(seedOutput());
      return await Promise.resolve(0);
    });
    expect(ok.code).toBe(0);
    const lines = ok.stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    const [token, operatorToken, a, b] = lines.map((line) => /^([A-Z_]+)='([^']*)'$/.exec(line));
    expect(token?.[1]).toBe('TOKEN');
    expect(operatorToken?.[1]).toBe('OPERATOR_TOKEN');
    expect(a?.slice(1)).toEqual(['A', A]);
    expect(b?.slice(1)).toEqual(['B', B]);
    expect(await verifyToken(token?.[2] ?? '', SETTINGS, NOW_MS / 1000)).toEqual({
      userId: '0192f0a0-0000-7000-8000-00000000d0c1',
      role: 'customer',
    });
    expect(await verifyToken(operatorToken?.[2] ?? '', SETTINGS, NOW_MS / 1000)).toEqual({
      userId: '0192f0a0-0000-7000-8000-00000000d0f1',
      role: 'operator',
    });

    const failed = await run(async (stdout, stderr) => {
      stdout.write('{"partial": ');
      stderr.write('seed: API not ready\n');
      return await Promise.resolve(1);
    });
    expect(failed.code).not.toBe(0);
    expect(failed.stdout).toBe('');
    expect(failed.stderr).toContain('seed');

    const incomplete = await run(async (stdout) => {
      stdout.write(seedOutput(false));
      return await Promise.resolve(0);
    });
    expect(incomplete.code).not.toBe(0);
    expect(incomplete.stdout).toBe('');
    expect(incomplete.stderr).toContain('demo-customer-2');

    // An account id that is not a UUID would reach the shell of `eval "$(make demo-env)"`.
    const injected = await run(async (stdout) => {
      stdout.write(seedOutput().replace(A, "x'; touch pwned; '"));
      return await Promise.resolve(0);
    });
    expect(injected.code).not.toBe(0);
    expect(injected.stdout).toBe('');
    expect(injected.stderr).toContain('no valid JSON');

    const makefile = readRepositoryFile('Makefile').split('\n');
    const start = makefile.findIndex((line) => line.startsWith('demo-env:'));
    expect(start).toBeGreaterThan(-1);
    const recipe = makefile
      .slice(start + 1)
      .filter((line, index, all) =>
        all.slice(0, index + 1).every((previous) => previous.startsWith('\t')),
      );
    expect(recipe).toEqual(['\t@$(TOOLS) npm run --silent demo-env']);
    expect(makefile.join('\n')).toMatch(
      /^TOOLS = \$\(COMPOSE\) build --quiet tools && \$\(COMPOSE\) run --rm tools$/m,
    );
  });
});
