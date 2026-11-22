import type { DiffHunk, FileChange, TextOp } from './models';
import { serializeJournalJson } from './journal';
import { deepEqual } from './plan';

function display(value: unknown): string {
  const type = value === null ? 'null' : Array.isArray(value) ? 'list' : typeof value;
  return `${serializeJournalJson(value)} (${type})`;
}

function lineBounds(source: string, start: number, end: number): { start: number; end: number } {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const nextNewline = source.indexOf('\n', end);
  let lineEnd = nextNewline < 0 ? source.length : nextNewline;
  if (lineEnd > lineStart && source[lineEnd - 1] === '\r') lineEnd--;
  return { start: lineStart, end: lineEnd };
}

function applySnippetOps(snippet: string, snippetStart: number, ops: readonly TextOp[]): string {
  const sorted = [...ops].sort((a, b) => b.start - a.start);
  let result = snippet;
  for (const op of sorted) {
    const relStart = op.start - snippetStart;
    const relEnd = op.end - snippetStart;
    if (relStart < 0 || relEnd > result.length || relEnd < relStart) continue;
    result = result.slice(0, relStart) + op.replacement + result.slice(relEnd);
  }
  return result;
}

export function diffForFile(change: FileChange, source?: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const { beforeFrontmatter: before, afterFrontmatter: after } = change;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const hadKey = Object.prototype.hasOwnProperty.call(before, key);
    const hasKey = Object.prototype.hasOwnProperty.call(after, key);
    if (!hadKey && hasKey) {
      hunks.push({ path: change.path, label: key, before: undefined, after: display(after[key]), kind: 'add' });
    } else if (hadKey && !hasKey) {
      hunks.push({ path: change.path, label: key, before: display(before[key]), after: undefined, kind: 'del' });
    } else if (hadKey && hasKey && !deepEqual(before[key], after[key])) {
      hunks.push({ path: change.path, label: key, before: display(before[key]), after: display(after[key]), kind: 'ctx' });
    }
  }
  if (!change.textOps.length) return hunks;
  if (!source) {
    for (const op of change.textOps) {
      hunks.push({ path: change.path, label: 'body', before: op.expect, after: op.replacement, kind: 'ctx' });
    }
    return hunks;
  }
  const sorted = [...change.textOps].sort((a, b) => a.start - b.start);
  const groups: { start: number; end: number; ops: TextOp[] }[] = [];
  for (const op of sorted) {
    const bounds = lineBounds(source, op.start, op.end);
    const last = groups.at(-1);
    if (last && bounds.start <= last.end) {
      last.end = Math.max(last.end, bounds.end);
      last.ops.push(op);
    } else {
      groups.push({ start: bounds.start, end: bounds.end, ops: [op] });
    }
  }
  for (const group of groups) {
    const beforeText = source.slice(group.start, group.end);
    const afterText = applySnippetOps(beforeText, group.start, group.ops);
    hunks.push({ path: change.path, label: 'body', before: beforeText, after: afterText, kind: 'ctx' });
  }
  return hunks;
}
