import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPOSITORY_ROOT, readRepositoryFile } from '../../support/deployment.js';

interface Section {
  level: number;
  title: string;
  body: string;
}

/** The Markdown headings of a document with the text under each, fenced code left in the body. */
function sectionsOf(markdown: string): Section[] {
  const sections: Section[] = [];
  let fence: string | undefined;
  for (const line of markdown.split('\n')) {
    const fenceMatch = /^(`{3,}|~{3,})/.exec(line);
    if (fenceMatch?.[1] !== undefined) {
      fence = fence === undefined ? fenceMatch[1] : line.startsWith(fence) ? undefined : fence;
    }
    const heading = fence === undefined ? /^(#{1,6})\s+(.*)$/.exec(line) : null;
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      sections.push({ level: heading[1].length, title: heading[2].trim(), body: '' });
    } else if (sections.length > 0) {
      const last = sections[sections.length - 1];
      if (last !== undefined) last.body += `${line}\n`;
    }
  }
  return sections;
}

/** The components and modules of table 1.3 of spec 008, read from the spec itself. */
function componentsOfTable13(): { component: string; module: string }[] {
  const spec = readRepositoryFile('specs/008-deployment/spec.md');
  const table = spec.slice(spec.indexOf('### 1.3'), spec.indexOf('### 1.4'));
  return [...table.matchAll(/^\|\s*([A-Z][A-Za-z ]+?)\s*\|\s*`([a-z-]+)`\s*\|/gm)].map((match) => ({
    component: match[1] ?? '',
    module: match[2] ?? '',
  }));
}

/** The modules each section names on its "Terraform module:" line. */
function modulesNamedBy(section: Section): string[] {
  return [
    ...section.body.matchAll(
      /^Terraform module: `([a-z-]+)` \(`infra\/terraform\/modules\/\1\/`\)/gm,
    ),
  ].map((match) => match[1] ?? '');
}

describe('docs/deployment/aws.md', () => {
  const document = readRepositoryFile('docs/deployment/aws.md');
  const sections = sectionsOf(document);
  const moduleFolders = readdirSync(join(REPOSITORY_ROOT, 'infra', 'terraform', 'modules'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  it('DEP-AC14 documents the architecture with a Mermaid diagram and one section per component of table 1.3, each naming its existing module, every module named once', () => {
    expect(document).toMatch(/```mermaid\n[\s\S]*?flowchart[\s\S]*?\n```/);

    const components = componentsOfTable13();
    expect(components.map((entry) => entry.component)).toEqual([
      'Network',
      'Edge',
      'Service',
      'Database',
      'Cache',
      'Secrets',
      'Observability',
    ]);
    for (const { component, module } of components) {
      const section = sections.find((candidate) => candidate.title === component);
      expect(section, component).toBeDefined();
      expect(section === undefined ? [] : modulesNamedBy(section), component).toEqual([module]);
    }

    const named = sections.flatMap(modulesNamedBy);
    expect([...named].sort()).toEqual(moduleFolders);
    for (const module of named) expect(moduleFolders, module).toContain(module);
  });

  it('DEP-AC14 holds the request path, the deployment and migration steps, the failure modes and a cost estimate', () => {
    const titles = sections.map((section) => section.title);
    for (const title of [
      'Request path',
      'Deployment and migration steps',
      'Failure modes',
      'Loss of a task',
      'Loss of an availability zone',
      'Database failover',
      'Loss of Redis',
      'Cost estimate',
    ]) {
      expect(titles, title).toContain(title);
      const section = sections.find((candidate) => candidate.title === title);
      expect(section?.body.trim().length ?? 0, title).toBeGreaterThan(0);
    }
  });
});
