import { describe, expect, it } from 'vitest';
import { readCompose, readRepositoryFile } from '../../support/deployment.js';

interface Instruction {
  keyword: string;
  args: string;
}

interface Stage {
  name: string | undefined;
  from: string;
  instructions: Instruction[];
}

/** The Dockerfile's instructions by stage, continuation lines joined and comments dropped. */
function stagesOf(text: string): Stage[] {
  const lines = text
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const stages: Stage[] = [];
  for (const line of lines) {
    const [keyword = '', ...rest] = line.split(/\s+/);
    const args = rest.join(' ');
    if (keyword.toUpperCase() === 'FROM') {
      const match = /^(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i.exec(args);
      if (match === null) throw new Error(`unexpected FROM ${args}`);
      stages.push({ from: match[1] ?? '', name: match[2], instructions: [] });
    } else {
      const stage = stages.at(-1);
      if (stage === undefined) throw new Error(`${keyword} before any FROM`);
      stage.instructions.push({ keyword: keyword.toUpperCase(), args });
    }
  }
  return stages;
}

/** An image reference with a version tag and a digest, such as `node:24.21.0-alpine@sha256:...`. */
// A version tag, such as `16.15-alpine` or Prometheus's `v3.15.0`, and a digest (DEP-R22).
const PINNED = /^[a-z0-9./_-]+:v?[0-9][A-Za-z0-9._-]*@sha256:[0-9a-f]{64}$/;

/** The sources of a COPY, without its flags and destination. */
function copySources(args: string): { from: string | undefined; sources: string[] } {
  const words = args.split(/\s+/);
  const from = words.find((word) => word.startsWith('--from='))?.slice('--from='.length);
  const paths = words.filter((word) => !word.startsWith('--'));
  return { from, sources: paths.slice(0, -1) };
}

describe('the Dockerfile', () => {
  it('DEP-AC12 builds in two stages from pinned images, runs as node with an exec-form entrypoint and a Node healthcheck on /health/live, and both replicas wait 40s to stop', () => {
    const stages = stagesOf(readRepositoryFile('Dockerfile'));

    // A build stage and a final runtime stage, with the tools stage of compose.yaml between them.
    expect(stages.map((stage) => stage.name)).toEqual(['build', 'tools', 'runtime']);
    const [build, tools, runtime] = stages as [Stage, Stage, Stage];
    // The runtime stage copies from the build stage only, never from tools, and only tools
    // downloads gitleaks, so building the production image never needs it.
    expect(
      runtime.instructions.filter(
        (i) => i.args.includes('--from=') && !i.args.includes('--from=build'),
      ),
    ).toEqual([]);
    for (const stage of [build, runtime]) expect(JSON.stringify(stage)).not.toContain('gitleaks');
    expect(JSON.stringify(tools)).toContain('gitleaks');
    expect(
      build.instructions.some((i) => i.keyword === 'RUN' && /npm run build/.test(i.args)),
    ).toBe(true);

    // Every FROM and every image: of compose.yaml is pinned by version and digest.
    for (const stage of stages) expect(stage.from, stage.name).toMatch(PINNED);
    const images = readCompose()
      .services.map((service) => service.image)
      .filter((image) => image !== undefined);
    expect(images.length).toBeGreaterThanOrEqual(3);
    for (const image of images) expect(image).toMatch(PINNED);

    // The runtime stage copies package.json, package-lock.json and dist/ from the build stage
    // only, and installs the production dependencies itself.
    const copies = runtime.instructions
      .filter((i) => i.keyword === 'COPY' || i.keyword === 'ADD')
      .map((i) => ({ keyword: i.keyword, ...copySources(i.args) }));
    expect(copies).toEqual([
      { keyword: 'COPY', from: undefined, sources: ['package.json', 'package-lock.json'] },
      { keyword: 'COPY', from: 'build', sources: ['/app/dist'] },
    ]);
    const installs = runtime.instructions.filter(
      (i) => i.keyword === 'RUN' && /\bnpm ci\b/.test(i.args),
    );
    expect(installs).toHaveLength(1);
    expect(installs[0]?.args).toMatch(/--omit=dev\b/);

    // The last USER is node.
    expect(runtime.instructions.filter((i) => i.keyword === 'USER').at(-1)?.args).toBe('node');

    // An exec-form entrypoint that runs node, and no CMD that starts a shell.
    const entrypoints = runtime.instructions.filter((i) => i.keyword === 'ENTRYPOINT');
    expect(entrypoints).toHaveLength(1);
    const entrypoint: unknown = JSON.parse(entrypoints[0]?.args ?? '');
    expect(Array.isArray(entrypoint) && entrypoint[0]).toBe('node');
    for (const cmd of runtime.instructions.filter((i) => i.keyword === 'CMD')) {
      expect(cmd.args.trim().startsWith('['), 'CMD in exec form').toBe(true);
      expect(cmd.args).not.toMatch(/\b(sh|bash|ash)\b/);
    }

    // The healthcheck runs node on a script that requests /health/live.
    const healthchecks = runtime.instructions.filter((i) => i.keyword === 'HEALTHCHECK');
    expect(healthchecks).toHaveLength(1);
    const command = /\bCMD\s+(\[.*\])$/.exec(healthchecks[0]?.args ?? '')?.[1];
    expect(JSON.parse(command ?? 'null')).toEqual(['node', 'dist/healthcheck.js']);
    expect(readRepositoryFile('src/healthcheck.ts')).toContain(
      "from './platform/health/liveness-probe.js'",
    );
    expect(readRepositoryFile('src/platform/health/liveness-probe.ts')).toContain('/health/live');

    // Both replicas wait 40 s before Docker kills them.
    const compose = readCompose();
    for (const name of ['api-1', 'api-2']) {
      expect(compose.service(name).stopGracePeriod, name).toBe('40s');
    }
  });
});
