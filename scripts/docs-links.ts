// The Markdown parsing of npm run docs:check (section 1.10 of spec 008, DEP-R47): the links of a
// Markdown text, the anchors GitHub gives its headings, and its mermaid blocks, as pure functions.
import { posix } from 'node:path';

export interface Link {
  target: string;
  line: number;
}

export interface MermaidBlock {
  /** The line of the opening fence, 1-based. */
  line: number;
  source: string;
}

export interface Failure {
  file: string;
  line: number;
  message: string;
}

/** The repository as the check sees it: paths relative to its root, without a trailing slash. */
export interface Repository {
  kind(path: string): 'file' | 'folder' | undefined;
  read(path: string): string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

interface Fence {
  char: string;
  length: number;
}

/**
 * Walks the lines of a Markdown text and calls `visit` for each one outside a fenced code block,
 * and `fenced` for each one inside, with the opening fence's info string and line. A fence closes
 * only with the same character repeated at least as many times, and nothing else on the line.
 */
function walk(
  text: string,
  visit: (line: string, number: number) => void,
  fenced?: (line: string | undefined, info: string, opening: number) => void,
): void {
  let open: (Fence & { info: string; line: number }) | undefined;
  text.split('\n').forEach((line, index) => {
    const number = index + 1;
    const match = FENCE.exec(line);
    const marker = match?.[1];
    if (open === undefined) {
      if (marker !== undefined && !(marker.startsWith('`') && (match?.[2] ?? '').includes('`'))) {
        open = {
          char: marker.charAt(0),
          length: marker.length,
          info: (match?.[2] ?? '').trim(),
          line: number,
        };
        return;
      }
      visit(line, number);
      return;
    }
    const closes =
      marker !== undefined &&
      marker.charAt(0) === open.char &&
      marker.length >= open.length &&
      (match?.[2] ?? '').trim() === '';
    if (closes) {
      fenced?.(undefined, open.info, open.line);
      open = undefined;
      return;
    }
    fenced?.(line, open.info, open.line);
  });
}

/** The line with every code span replaced by spaces, so nothing inside one is read as a link. */
function withoutCodeSpans(line: string): string {
  return line.replace(/(`+)[^`]*?\1/g, (span) => ' '.repeat(span.length));
}

const INLINE_TARGET = /\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/;

function unwrap(target: string): string {
  return target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
}

/** Every link target of the text outside code blocks and code spans, in order, with its line. */
export function markdownLinks(text: string): Link[] {
  const links: Link[] = [];
  walk(text, (raw, line) => {
    const content = withoutCodeSpans(raw);
    const definition = REFERENCE_DEFINITION.exec(content);
    if (definition?.[1] !== undefined) {
      links.push({ target: unwrap(definition[1]), line });
      return;
    }
    for (const match of content.matchAll(INLINE_TARGET)) {
      if (match[1] !== undefined) links.push({ target: unwrap(match[1]), line });
    }
  });
  return links;
}

const HEADING = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** The text GitHub renders for a heading's Markdown: no code marks, link targets, emphasis or tags. */
function headingText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*]/g, '');
}

/**
 * The anchors GitHub gives the headings of the text, in order: the heading's text in lowercase,
 * without the characters that are not letters, marks, numbers, connector punctuation, spaces or
 * hyphens, each space a hyphen, and `-1`, `-2` ... added to a repeated one.
 */
export function githubAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  walk(text, (line) => {
    const match = HEADING.exec(line);
    if (match?.[1] === undefined) return;
    const base = headingText(match[1])
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
      .replace(/ /g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${String(count)}`);
  });
  return anchors;
}

/** Every fenced block whose info string is `mermaid`, with its source and opening line. */
export function mermaidBlocks(text: string): MermaidBlock[] {
  const blocks: MermaidBlock[] = [];
  let current: MermaidBlock | undefined;
  walk(
    text,
    () => undefined,
    (line, info, opening) => {
      if (info.split(/\s+/)[0] !== 'mermaid') return;
      if (line === undefined) {
        if (current !== undefined) blocks.push(current);
        current = undefined;
        return;
      }
      current ??= { line: opening, source: '' };
      current.source += `${line}\n`;
    },
  );
  return blocks;
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * The links of `file`'s text that fail DEP-R47: a relative target naming no file or folder of the
 * repository, or leaving it, or a `#` anchor that no heading of its target Markdown file has.
 * Targets with a scheme (`https:`, `mailto:` and the others) are not checked.
 */
export function linkFailures(file: string, text: string, repository: Repository): Failure[] {
  const failures: Failure[] = [];
  for (const { target, line } of markdownLinks(text)) {
    if (SCHEME.test(target)) continue;
    const fail = (message: string): void => {
      failures.push({ file, line, message: `${target}: ${message}` });
    };
    const hash = target.indexOf('#');
    const pathPart = (hash === -1 ? target : target.slice(0, hash)).split('?')[0] ?? '';
    const anchor = hash === -1 ? undefined : target.slice(hash + 1);
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      fail('the target is not valid percent-encoding');
      continue;
    }
    let path = file;
    if (decoded !== '') {
      const joined = decoded.startsWith('/')
        ? posix.normalize(decoded.slice(1))
        : posix.join(posix.dirname(file), decoded);
      path = joined.replace(/\/+$/, '');
      if (path === '..' || path.startsWith('../')) {
        fail('the path leaves the repository');
        continue;
      }
      if (path === '.' || path === '') path = '.';
      if (path !== '.' && repository.kind(path) === undefined) {
        fail(`${path} does not exist`);
        continue;
      }
    }
    if (anchor === undefined || anchor === '' || !path.endsWith('.md')) continue;
    let decodedAnchor: string;
    try {
      decodedAnchor = decodeURIComponent(anchor);
    } catch {
      fail('the anchor is not valid percent-encoding');
      continue;
    }
    const anchors = githubAnchors(path === file ? text : repository.read(path));
    if (!anchors.has(decodedAnchor.toLowerCase())) {
      fail(`${path} has no heading with the anchor #${anchor}`);
    }
  }
  return failures;
}
