import type { DiffHunk, FileChange } from './models';
import { deepEqual } from './plan';

function display(value: unknown): string {
  const type = value === null ? 'null' : Array.isArray(value) ? 'list' : typeof value;
  return `${JSON.stringify(value)} (${type})`;
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
  for (const op of change.textOps) {
      hunks.push({ path: change.path, label: 'body', before: source ? source.slice(source.lastIndexOf('\n', op.start - 1) + 1, source.indexOf('\n', op.end) < 0 ? source.length : source.indexOf('\n', op.end)) : op.expect, after: op.replacement, kind: 'ctx' });
  }
  return hunks;
}
