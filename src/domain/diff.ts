import type { ChangePlan, DiffHunk, FileChange } from './models';

function display(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `[${value.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join(', ')}]`;
  if (value === undefined) return '(empty)';
  return JSON.stringify(value);
}

export function diffForFile(change: FileChange): DiffHunk[] {
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
    } else if (hadKey && hasKey && display(before[key]) !== display(after[key])) {
      hunks.push({ path: change.path, label: key, before: display(before[key]), after: display(after[key]), kind: 'ctx' });
    }
  }
  for (const edit of change.edits) {
    if (edit.target !== 'content' || !edit.textOps) continue;
    for (const op of edit.textOps) {
      hunks.push({ path: change.path, label: '正文标签', before: op.expect, after: op.replacement, kind: 'ctx' });
    }
  }
  return hunks;
}

export function buildDiffs(plan: ChangePlan): DiffHunk[] {
  return plan.fileChanges.filter(change => !change.skipped).flatMap(diffForFile);
}
