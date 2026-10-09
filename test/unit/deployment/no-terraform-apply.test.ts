import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT, readRepositoryFile } from '../../support/deployment.js';

/**
 * DEP-AC24 (DEP-R34): nothing in the repository applies the Terraform or holds AWS credentials.
 * The files are walked on disk rather than listed with git, so the test also runs in the tools
 * image, whose build context has no `.git`.
 */

/** Never searched: the documentation and the specs (DEP-AC24), and what is generated or local. */
const SKIPPED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  'reports',
  '.terraform',
  '.tflint.d',
  '.infra-scratch',
  'docs',
  'specs',
]);

/** Binary or opaque files, which hold no command. */
const SKIPPED_EXTENSIONS = /\.(png|jpe?g|gif|ico|pem|lock\.hcl)$/;

function repositoryFiles(directory: string = REPOSITORY_ROOT): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return SKIPPED_DIRECTORIES.has(name) ? [] : repositoryFiles(path);
    }
    return SKIPPED_EXTENSIONS.test(name) ? [] : [relative(REPOSITORY_ROOT, path)];
  });
}

/** Comment lines can name a command without running it; prose in Markdown runs nothing. */
const COMMENT_LINE = /^\s*(#|\/\/|\/\*|\*)/;

/**
 * What a file could run. `.claude/settings.json` denies the commands to agents: its `deny` list is
 * the opposite of running them, so it is left out.
 */
function executableText(path: string): string {
  const text = readFileSync(join(REPOSITORY_ROOT, path), 'utf8');
  if (path.endsWith('.md')) return '';
  if (path === join('.claude', 'settings.json')) {
    const settings = JSON.parse(text) as { permissions?: { deny?: unknown } };
    delete settings.permissions?.deny;
    return JSON.stringify(settings);
  }
  return text
    .split('\n')
    .filter((line) => !COMMENT_LINE.test(line))
    .join('\n');
}

// Built from parts, so this file never holds the commands it looks for.
const TERRAFORM_COMMAND = new RegExp(
  `terraform\\s+(${['apply', 'plan', 'destroy', 'import'].join('|')})\\b`,
);
const ACCESS_KEY_ID = new RegExp(
  `\\b(${['AK', 'IA'].join('')}|${['AS', 'IA'].join('')})[0-9A-Z]{16}\\b`,
);
const SECRET_SETTINGS = new RegExp(
  `(${['aws_secret', '_access_key'].join('')}|${['aws_session', '_token'].join('')})\\s*[=:]`,
  'i',
);

/** The body of every `<keyword> "<label>" ... { ... }` block of an HCL text, comments removed. */
function hclBlocks(text: string, header: RegExp): string[] {
  const code = text
    .split('\n')
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join('\n');
  const blocks: string[] = [];
  for (const match of code.matchAll(new RegExp(header.source, 'g'))) {
    let depth = 0;
    const start = match.index + match[0].length - 1;
    for (let index = start; index < code.length; index += 1) {
      if (code[index] === '{') depth += 1;
      if (code[index] === '}') depth -= 1;
      if (depth === 0) {
        blocks.push(code.slice(start + 1, index));
        break;
      }
    }
  }
  return blocks;
}

function terraformFiles(): string[] {
  return repositoryFiles().filter((path) => path.endsWith('.tf'));
}

describe('nothing applies the Terraform', () => {
  it('DEP-AC24 no file runs the Terraform subcommands apply, plan, destroy or import, and infra:validate passes Terraform only fmt, init and validate', () => {
    const files = repositoryFiles();
    expect(files).toContain(join('scripts', 'infra-validate.sh'));
    for (const path of files) {
      expect(TERRAFORM_COMMAND.test(executableText(path)), path).toBe(false);
    }

    // The script runs Terraform from its image, so the subcommand follows the `--` of docker_run.
    const script = readRepositoryFile('scripts/infra-validate.sh');
    const subcommands = [
      ...script.matchAll(/docker_run "\$\{TERRAFORM_IMAGE\}"[^\n]*? -- (\w+)/g),
    ].map((match) => match[1]);
    expect(subcommands).toEqual(['fmt', 'init', 'validate']);
    expect(readRepositoryFile('package.json')).toContain(
      '"infra:validate": "bash scripts/infra-validate.sh"',
    );
  });

  it('DEP-AC24 no file holds an AWS access key id, secret access key or session token', () => {
    for (const path of repositoryFiles()) {
      const text = readFileSync(join(REPOSITORY_ROOT, path), 'utf8');
      expect(ACCESS_KEY_ID.test(text), path).toBe(false);
      expect(SECRET_SETTINGS.test(text), path).toBe(false);
    }
  });

  it('DEP-AC24 the backend block holds no bucket, key or table name, and no aws provider sets credentials', () => {
    const files = terraformFiles();
    const backends = files.flatMap((path) =>
      hclBlocks(readRepositoryFile(path), /backend\s+"[^"]+"\s*\{/),
    );
    expect(backends.length).toBeGreaterThan(0);
    for (const body of backends) {
      expect(body, 'backend').not.toMatch(/\b(bucket|key|dynamodb_table|table)\s*=/);
    }

    const providers = files.flatMap((path) =>
      hclBlocks(readRepositoryFile(path), /provider\s+"aws"\s*\{/),
    );
    expect(providers.length).toBeGreaterThan(0);
    for (const body of providers) {
      expect(body, 'provider "aws"').not.toMatch(
        /\b(access_key|secret_key|token|profile|shared_credentials_files|shared_config_files|assume_role|assume_role_with_web_identity)\b/,
      );
    }
  });
});
