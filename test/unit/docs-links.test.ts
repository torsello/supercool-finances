import { describe, expect, it } from 'vitest';
import {
  githubAnchors,
  linkFailures,
  markdownLinks,
  mermaidBlocks,
  type Repository,
} from '../../scripts/docs-links.js';

/** A repository of a few files and folders, with the Markdown files' texts. */
function repository(files: Record<string, string>, folders: readonly string[] = []): Repository {
  return {
    kind: (path) => {
      if (path in files) return 'file';
      return folders.includes(path) ? 'folder' : undefined;
    },
    read: (path) => files[path] ?? '',
  };
}

describe('docs links (DEP-R47)', () => {
  it('DEP-R47 finds inline links, images, nested badges and reference definitions, with their lines', () => {
    const text = [
      '# Title',
      '',
      '[![CI](https://example.com/badge.svg)](https://example.com/ci)',
      'See [the spec](specs/001-accounts/spec.md#2-requirements) and ![a diagram](docs/a.png "A").',
      '[angle](<docs/with space.md>)',
      '',
      '[ref]: docs/adr/README.md',
    ].join('\n');
    expect(markdownLinks(text)).toEqual([
      { target: 'https://example.com/badge.svg', line: 3 },
      { target: 'https://example.com/ci', line: 3 },
      { target: 'specs/001-accounts/spec.md#2-requirements', line: 4 },
      { target: 'docs/a.png', line: 4 },
      { target: 'docs/with space.md', line: 5 },
      { target: 'docs/adr/README.md', line: 7 },
    ]);
  });

  it('DEP-R47 ignores links inside fenced code blocks and code spans', () => {
    const text = [
      'Use `[x](missing.md)` literally.',
      '```markdown',
      '[inside](missing.md)',
      '```',
      '~~~~',
      '```',
      '[still inside](missing.md)',
      '~~~~',
      '[outside](present.md)',
    ].join('\n');
    expect(markdownLinks(text)).toEqual([{ target: 'present.md', line: 9 }]);
  });

  it('DEP-R47 derives GitHub anchors: lowercase, punctuation dropped, spaces to hyphens, duplicates numbered', () => {
    const text = [
      '# SuperCool Finances',
      '## 1. Context and goal',
      '### `npm run docs:check`',
      '## Design decisions',
      '## Design decisions',
      '## [Linked](x.md) **bold** heading',
      '```',
      '## Not a heading',
      '```',
      '#Not a heading either',
    ].join('\n');
    expect([...githubAnchors(text)]).toEqual([
      'supercool-finances',
      '1-context-and-goal',
      'npm-run-docscheck',
      'design-decisions',
      'design-decisions-1',
      'linked-bold-heading',
    ]);
  });

  it('DEP-R47 extracts every mermaid block with the line of its fence', () => {
    const text = ['a', '```mermaid', 'flowchart LR', '  A --> B', '```', '```sh', 'ls', '```'].join(
      '\n',
    );
    expect(mermaidBlocks(text)).toEqual([{ line: 2, source: 'flowchart LR\n  A --> B\n' }]);
  });

  it('DEP-R47 reports a missing file, a missing anchor and a path outside the repository, and accepts the rest', () => {
    const repo = repository(
      {
        'README.md': '',
        'docs/guide.md': '# Guide\n## Run it\n',
        'src/app.ts': '',
      },
      ['docs', 'infra/terraform'],
    );
    const text = [
      '[ok](guide.md#run-it)',
      '[ok folder](../infra/terraform/)',
      '[ok code line](../src/app.ts#L10)',
      '[ok external](https://example.com/missing)',
      '[ok mail](mailto:someone@example.com)',
      '[ok self](#guide)',
      '[ok root](/README.md)',
      '[missing file](missing.md)',
      '[missing anchor](guide.md#deploy-it)',
      '[missing self anchor](#nope)',
      '[outside](../../elsewhere.md)',
    ].join('\n');
    const guide = '# Guide\n## Run it\n';
    expect(linkFailures('docs/guide.md', `${guide}${text}`, repo)).toEqual([
      { file: 'docs/guide.md', line: 10, message: 'missing.md: docs/missing.md does not exist' },
      {
        file: 'docs/guide.md',
        line: 11,
        message: 'guide.md#deploy-it: docs/guide.md has no heading with the anchor #deploy-it',
      },
      {
        file: 'docs/guide.md',
        line: 12,
        message: '#nope: docs/guide.md has no heading with the anchor #nope',
      },
      {
        file: 'docs/guide.md',
        line: 13,
        message: '../../elsewhere.md: the path leaves the repository',
      },
    ]);
  });

  it('DEP-R47 decodes percent-encoded targets', () => {
    const repo = repository({ 'docs/with space.md': '# A\n' });
    expect(linkFailures('README.md', '[x](docs/with%20space.md#a)', repo)).toEqual([]);
  });

  it('DEP-R47 reports an anchor that is not valid percent-encoding at its file and line, without throwing', () => {
    const repo = repository({ 'docs/guide.md': '# Guide\n' });
    expect(linkFailures('README.md', '# T\n\n[x](docs/guide.md#100%)', repo)).toEqual([
      {
        file: 'README.md',
        line: 3,
        message: 'docs/guide.md#100%: the anchor is not valid percent-encoding',
      },
    ]);
  });
});
