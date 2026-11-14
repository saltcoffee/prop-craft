import { parser, Strikethrough } from '@lezer/markdown';
import type { CachedTag } from '../ports/VaultPort';

const markdownParser = parser.configure(Strikethrough);
const excludedNodes = new Set(['Comment', 'EmphasisMark', 'StrikethroughMark', 'InlineCode', 'FencedCode', 'CodeBlock', 'Image', 'HTMLBlock', 'HTMLTag', 'CommentBlock', 'ProcessingInstructionBlock', 'URL', 'Autolink', 'Escape', 'Entity', 'HeaderMark']);

/** Parse Markdown syntax first; tag positions always belong to this exact source. */
export function parseBodyTags(source: string, bodyStart: number): CachedTag[] {
  const body = source.slice(bodyStart);
  const excluded: Array<[number, number]> = [];
  const collectSyntax = (text: string, offset: number): void => {
    markdownParser.parse(text).iterate({ enter(node) {
      if (node.name === 'LinkReference' && text.startsWith('[^', node.from)) {
        const contentStart = text.indexOf(':', node.from) + 1;
        collectSyntax(text.slice(contentStart, node.to), offset + contentStart);
        return false;
      }
      if (excludedNodes.has(node.name) || node.name === 'LinkReference' || node.name === 'Link' && text.slice(node.from, node.from + 2) === '[[') {
        excluded.push([offset + node.from, offset + node.to]);
        return false;
      }
    } });
  };
  collectSyntax(body, 0);
  // Obsidian math, wikilinks, and bare URLs extend CommonMark's inline syntax.
  for (const match of body.matchAll(/!?\[\[[^\]]*(?:\][^\]])*\]\]|(?:https?:\/\/|www\.)[^\s<>]+|(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$|(?<![\\$])\$(?!\s)[^$\n]+?(?<![\s\\])\$(?!\d)/g)) {
    excluded.push([match.index, match.index + match[0].length]);
  }
  excluded.sort((a, b) => a[0] - b[0]);
  const ranges: Array<[number, number]> = [];
  for (const span of excluded) {
    const previous = ranges.at(-1);
    if (previous && span[0] <= previous[1]) previous[1] = Math.max(previous[1], span[1]);
    else ranges.push([...span]);
  }
  const tags: CachedTag[] = [];
  let range = 0;
  for (const match of body.matchAll(/#(?:(?![#$+<=>^`|~])[\p{L}\p{M}\p{N}\p{S}_/-])+/gu)) {
    const start = match.index; let end = start + match[0].length;
    let slashCount = 0;
    while (body[start - slashCount - 1] === '\\') slashCount++;
    if (slashCount % 2) continue;
    const previous = body[start - slashCount - 1];
    if (previous && !/[\s[*>_~]/u.test(previous)) continue;
    while (range < ranges.length && ranges[range][1] <= start) range++;
    if (range < ranges.length) {
      if (ranges[range][0] <= start) continue;
      if (ranges[range][0] < end) end = ranges[range][0];
    }
    const tag = body.slice(start, end);
    if (tag.length < 2 || /^#\p{N}+$/u.test(tag)) continue;
    tags.push({ tag, start: bodyStart + start, end: bodyStart + end });
  }
  return tags;
}
