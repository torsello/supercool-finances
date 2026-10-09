// npm run docs:check (section 1.10 of spec 008, DEP-R47): every Markdown file tracked by git must
// have only relative links that resolve in the repository, and only mermaid diagrams that render.
// Each diagram is rendered by the Mermaid CLI from its official image, pinned by version and
// digest, fed on standard input so nothing is mounted. External URLs are not checked. Exit 0 when
// clean, 1 on any failure, 2 when it cannot run (no git or no Docker).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { linkFailures, mermaidBlocks, type Failure, type Repository } from './docs-links.js';

const MERMAID_IMAGE =
  'minlag/mermaid-cli:12.0.1@sha256:2c5d27365df71da06c288beebe531ea3637cf9b422b871239a3b016233591d24';

/** Diagrams rendered at the same time; each one starts a headless browser. */
const CONCURRENCY = 4;

const root = process.cwd();

function trackedMarkdownFiles(): string[] {
  const result = spawnSync('git', ['ls-files', '-z', '--', '*.md'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(`docs:check: git ls-files failed: ${result.stderr}\n`);
    process.exit(2);
  }
  return result.stdout.split('\0').filter((path) => path !== '');
}

const repository: Repository = {
  kind(path) {
    try {
      const stat = statSync(join(root, path));
      return stat.isDirectory() ? 'folder' : 'file';
    } catch {
      return undefined;
    }
  },
  read(path) {
    return readFileSync(join(root, path), 'utf8');
  },
};

/** Renders one diagram; resolves to the CLI's error, or `undefined` when it rendered. */
function render(source: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(
      'docker',
      [
        'run',
        '--rm',
        '--interactive',
        MERMAID_IMAGE,
        '--input',
        '-',
        '--output',
        '-',
        '--outputFormat',
        'svg',
        '--quiet',
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      resolve(`docker could not run: ${error.message}`);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(undefined);
        return;
      }
      // The parser's message, without the browser's stack trace.
      const message = stderr
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('at '))
        .slice(0, 4)
        .join(' | ');
      resolve(message === '' ? `the Mermaid CLI exited with ${String(code)}` : message);
    });
    child.stdin.end(source);
  });
}

async function renderAll(
  blocks: readonly { file: string; line: number; source: string }[],
): Promise<Failure[]> {
  const failures: Failure[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < blocks.length; index = next++) {
      const block = blocks[index];
      if (block === undefined) continue;
      const error = await render(block.source);
      if (error !== undefined) {
        failures.push({ file: block.file, line: block.line, message: `mermaid: ${error}` });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return failures;
}

function requireDocker(): void {
  const result = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write('docs:check: Docker is required to render the mermaid diagrams\n');
    process.exit(2);
  }
}

const files = trackedMarkdownFiles();
const failures: Failure[] = [];
const blocks: { file: string; line: number; source: string }[] = [];
for (const file of files) {
  const text = repository.read(file);
  failures.push(...linkFailures(file, text, repository));
  for (const block of mermaidBlocks(text)) blocks.push({ file, ...block });
}
if (blocks.length > 0) requireDocker();
failures.push(...(await renderAll(blocks)));

failures.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
for (const { file, line, message } of failures) {
  process.stderr.write(`${file}:${String(line)}: ${message}\n`);
}
process.stdout.write(
  `docs:check: ${String(files.length)} Markdown files, ${String(blocks.length)} mermaid diagrams, ${String(failures.length)} failures\n`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
