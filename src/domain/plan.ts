import type {
  ConflictStrategy, FileChange, FileMeta, MergeStrategy, PropertyValueType, RegionFormat,
} from './models';
import { isValidTag, stripHash, tagWithHash } from './normalize';
import { normalizeDateValue } from './date';

const hasOwn = (object: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    return ak.length === bk.length && ak.every(key => deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }
  return false;
}

function cloneFrontmatter(file: FileMeta): Record<string, unknown> {
  return { ...file.rawFrontmatter };
}

function tagKeyOf(fm: Record<string, unknown>): 'tags' | 'tag' | null {
  if (hasOwn(fm, 'tags')) return 'tags';
  if (hasOwn(fm, 'tag')) return 'tag';
  return null;
}

function rewriteTagEntry(entry: string, from: string, to: string): string {
  if (stripHash(entry) !== stripHash(from)) return entry;
  return entry.startsWith('#') ? to : stripHash(to);
}

function dedupeTarget(values: unknown[], target: string): unknown[] {
  let seen = false;
  return values.filter(value => {
    if (typeof value !== 'string' || stripHash(value) !== stripHash(target)) return true;
    if (seen) return false;
    seen = true;
    return true;
  });
}

/** Rewrite a frontmatter tags value in place; returns null when nothing matched. */
export function rewriteFrontmatterTag(
  fm: Record<string, unknown>, from: string, to: string,
): { key: 'tags' | 'tag'; value: unknown } | null {
  const key = tagKeyOf(fm);
  if (!key) return null;
  const raw = fm[key];
  if (Array.isArray(raw)) {
    let changed = false;
    const mapped = raw.map((entry: unknown) => {
      if (typeof entry !== 'string') return entry;
      const next = rewriteTagEntry(entry, from, to);
      if (next !== entry) changed = true;
      return next;
    });
    if (!changed) return null;
    return { key, value: dedupeTarget(mapped, to) };
  }
  if (typeof raw === 'string') {
    const parts = raw.split(',').map(part => part.trim()).filter(Boolean);
    let changed = false;
    const mapped = parts.map(entry => {
      const next = rewriteTagEntry(entry, from, to);
      if (next !== entry) changed = true;
      return next;
    });
    if (!changed) return null;
    return { key, value: dedupeTarget(mapped, to).join(', ') };
  }
  return null;
}

export function planRenameTag(file: FileMeta, from: string, to: string): FileChange | null {
  from = tagWithHash(from);
  to = tagWithHash(to);
  if (!isValidTag(to) || from === to) return null;
  const beforeFrontmatter = cloneFrontmatter(file);
  const afterFrontmatter = cloneFrontmatter(file);
  const edits: FileChange['edits'] = [];

  const positions = file.tags.filter(tag => tag.tag === from).flatMap(tag => tag.positions);
  if (positions.length > 0) {
    const textOps = [...positions]
      .sort((a, b) => b.start - a.start)
      .map(position => ({ start: position.start, end: position.end, expect: from, replacement: to }));
    edits.push({ target: 'content', textOps });
  }

  const rewritten = rewriteFrontmatterTag(beforeFrontmatter, from, to);
  if (rewritten) {
    afterFrontmatter[rewritten.key] = rewritten.value;
    edits.push({ target: 'frontmatter', fmOp: { set: { [rewritten.key]: rewritten.value } } });
  }

  if (edits.length === 0) return null;
  // Content edits must come before frontmatter edits: frontmatter serialization can shift body offsets.
  edits.sort((a, b) => (a.target === 'content' ? -1 : 1) - (b.target === 'content' ? -1 : 1));
  return { path: file.path, expectedMtime: file.mtime, beforeFrontmatter, afterFrontmatter, edits };
}

export const planMergeTag = planRenameTag;

function resolveMergeValue(
  targetValue: unknown, sourceValue: unknown, targetPresent: boolean, strategy: MergeStrategy,
): { value: unknown; conflict: boolean; keepTarget: boolean } {
  if (!targetPresent) return { value: sourceValue, conflict: false, keepTarget: false };
  if (deepEqual(targetValue, sourceValue)) return { value: targetValue, conflict: false, keepTarget: true };
  switch (strategy) {
    case 'keep-source':
      return { value: sourceValue, conflict: false, keepTarget: false };
    case 'merge-list':
      if (Array.isArray(targetValue) && Array.isArray(sourceValue)) {
        const merged = [...(targetValue as unknown[])];
        for (const item of sourceValue as unknown[]) {
          if (!merged.some(existing => deepEqual(existing, item))) merged.push(item);
        }
        return { value: merged, conflict: false, keepTarget: false };
      }
      return { value: targetValue, conflict: true, keepTarget: true };
    case 'keep-target':
    default:
      return { value: targetValue, conflict: false, keepTarget: true };
  }
}

export function planRenameProperty(file: FileMeta, from: string, to: string): FileChange | null {
  if (from === to) return null;
  const fm = file.rawFrontmatter;
  if (!hasOwn(fm, from)) return null;
  const beforeFrontmatter = cloneFrontmatter(file);
  const afterFrontmatter = cloneFrontmatter(file);
  afterFrontmatter[to] = fm[from];
  delete afterFrontmatter[from];
  return {
    path: file.path,
    expectedMtime: file.mtime,
    beforeFrontmatter,
    afterFrontmatter,
    edits: [{ target: 'frontmatter', fmOp: { set: { [to]: fm[from] }, delete: [from] } }],
  };
}

export function planMergeProperty(file: FileMeta, from: string, to: string, strategy: MergeStrategy): FileChange | null {
  if (from === to) return null;
  const fm = file.rawFrontmatter;
  if (!hasOwn(fm, from)) return null;
  const beforeFrontmatter = cloneFrontmatter(file);
  const targetPresent = hasOwn(fm, to);
  const resolved = resolveMergeValue(fm[to], fm[from], targetPresent, strategy);
  if (strategy === 'skip' && targetPresent && !deepEqual(fm[to], fm[from])) return null;
  const afterFrontmatter = cloneFrontmatter(file);
  afterFrontmatter[to] = resolved.value;
  delete afterFrontmatter[from];
  return {
    path: file.path,
    expectedMtime: file.mtime,
    beforeFrontmatter,
    afterFrontmatter,
    edits: [{ target: 'frontmatter', fmOp: { set: { [to]: resolved.value }, delete: [from] } }],
    ...(resolved.conflict ? { conflict: { reason: 'values differ', resolvedBy: 'keep-target' } } : {}),
  };
}

export function planDeleteProperty(file: FileMeta, key: string): FileChange | null {
  if (!hasOwn(file.rawFrontmatter, key)) return null;
  const beforeFrontmatter = cloneFrontmatter(file);
  const afterFrontmatter = cloneFrontmatter(file);
  delete afterFrontmatter[key];
  return {
    path: file.path,
    expectedMtime: file.mtime,
    beforeFrontmatter,
    afterFrontmatter,
    edits: [{ target: 'frontmatter', fmOp: { delete: [key] } }],
  };
}

export function planAddProperty(
  file: FileMeta, key: string, value: unknown, _valueType: PropertyValueType, onConflict: ConflictStrategy,
): FileChange | null {
  const fm = file.rawFrontmatter;
  const beforeFrontmatter = cloneFrontmatter(file);
  const afterFrontmatter = cloneFrontmatter(file);
  if (hasOwn(fm, key)) {
    if (onConflict === 'skip') return null;
    if (onConflict === 'append') {
      const existing = fm[key];
      if (Array.isArray(existing) && Array.isArray(value)) {
        afterFrontmatter[key] = [...(existing as unknown[]), ...(value as unknown[])];
      } else if (Array.isArray(existing)) {
        afterFrontmatter[key] = [...(existing as unknown[]), value];
      } else {
        afterFrontmatter[key] = [existing, value];
      }
    } else {
      afterFrontmatter[key] = value;
    }
  } else {
    afterFrontmatter[key] = value;
  }
  return {
    path: file.path,
    expectedMtime: file.mtime,
    beforeFrontmatter,
    afterFrontmatter,
    edits: [{ target: 'frontmatter', fmOp: { set: { [key]: afterFrontmatter[key] } } }],
  };
}

export function planNormalizeDate(
  file: FileMeta, key: string, target: 'date' | 'datetime', region: RegionFormat,
): FileChange | null {
  const value = file.rawFrontmatter[key];
  if (typeof value !== 'string') return null;
  const parsed = normalizeDateValue(value, target, region);
  if (!parsed.ok || !parsed.iso || parsed.iso === value) return null;
  const beforeFrontmatter = cloneFrontmatter(file);
  const afterFrontmatter = cloneFrontmatter(file);
  afterFrontmatter[key] = parsed.iso;
  return {
    path: file.path,
    expectedMtime: file.mtime,
    beforeFrontmatter,
    afterFrontmatter,
    edits: [{ target: 'frontmatter', fmOp: { set: { [key]: parsed.iso } } }],
  };
}
