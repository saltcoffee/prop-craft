import type { ChangeOperation, ConflictStrategy, FileChange, FileMeta, MergeStrategy, PropertyValueType, RegionFormat, TextOp } from './models';
import type { AnalyzedOperation, PreviewDecision } from './preview';
import { isValidTag, tagIdentity, stripHash, tagWithHash } from './normalize';
import { normalizeDateValue } from './date';
import { hasOwn } from './scope';
import { OperationError } from './errors';

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b)
    && a.length === b.length && a.every((value, index) => deepEqual(value, b[index]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => hasOwn(right, key) && deepEqual(left[key], right[key]));
  }
  return false;
}
function cloneFrontmatter(file: FileMeta): Record<string, unknown> {
  return Object.assign(Object.create(null) as Record<string, unknown>, file.rawFrontmatter);
}
function fmChange(file: FileMeta, after: Record<string, unknown>): FileChange {
  return { path: file.path, beforeFrontmatter: cloneFrontmatter(file), afterFrontmatter: after, textOps: [] };
}
function rewriteTagEntry(entry: string, from: string, to: string): string {
  if (tagIdentity(entry) !== tagIdentity(from)) return entry;
  return entry.startsWith('#') ? to : stripHash(to);
}
function dedupeTarget(values: unknown[], target: string): unknown[] {
  let seen = false;
  return values.filter(value => {
    if (typeof value !== 'string' || tagIdentity(value) !== tagIdentity(target)) return true;
    if (seen) return false;
    seen = true;
    return true;
  });
}
export function rewriteFrontmatterTag(fm: Record<string, unknown>, from: string, to: string, key: 'tags' | 'tag' = 'tags'): { key: 'tags' | 'tag'; value: unknown } | null {
  if (!hasOwn(fm, key)) return null;
  const raw = fm[key];
  if (Array.isArray(raw)) {
    const mapped = raw.map(entry => typeof entry === 'string' ? rewriteTagEntry(entry, from, to) : entry);
    return deepEqual(mapped, raw) ? null : { key, value: dedupeTarget(mapped, to) };
  }
  if (typeof raw === 'string') {
    const parts = raw.split(',').map(part => part.trim()).filter(Boolean);
    const mapped = parts.map(entry => rewriteTagEntry(entry, from, to));
    return deepEqual(mapped, parts) ? null : { key, value: dedupeTarget(mapped, to).join(', ') };
  }
  return null;
}
export function planRenameTag(file: FileMeta, from: string, to: string): FileChange | null {
  from = tagWithHash(from); to = tagWithHash(to);
  if (!isValidTag(to) || from === to) return null;
  const beforeFrontmatter = cloneFrontmatter(file), afterFrontmatter = cloneFrontmatter(file);
  const textOps = file.tags.filter(tag => tagIdentity(tag.tag) === tagIdentity(from)).flatMap(tag =>
    tag.positions.map(position => ({ ...position, expect: tag.tag, replacement: to }))).filter(op => op.expect !== op.replacement);
  for (const key of ['tags', 'tag'] as const) {
    const rewrite = rewriteFrontmatterTag(beforeFrontmatter, from, to, key);
    if (rewrite) {
      afterFrontmatter[key] = rewrite.value;
    }
  }
  return textOps.length || !deepEqual(beforeFrontmatter, afterFrontmatter) ? { path: file.path, beforeFrontmatter, afterFrontmatter, textOps } : null;
}
export const planMergeTag = planRenameTag;

export function planMergeProperty(file: FileMeta, from: string, to: string, strategy?: MergeStrategy): FileChange | null {
  const fm = file.rawFrontmatter;
  if (from === to || !hasOwn(fm, from) || strategy === 'skip') return null;
  const targetPresent = hasOwn(fm, to);
  const equal = targetPresent && deepEqual(fm[to], fm[from]);
  const lists = Array.isArray(fm[to]) && Array.isArray(fm[from]);
  if (targetPresent && !equal && !strategy && !lists) return null;
  let value = fm[from];
  if (targetPresent && (equal || strategy === 'keep-target')) value = fm[to];
  else if (targetPresent && (strategy === 'merge-list' || !strategy && lists)) {
    if (!lists) return null;
    const merged = [...(fm[to] as unknown[])];
    for (const item of fm[from] as unknown[]) if (!merged.some(existing => deepEqual(existing, item))) merged.push(item);
    value = merged;
  }
  const after = cloneFrontmatter(file);
  after[to] = value; delete after[from];
  return fmChange(file, after);
}
export function planRenameProperty(file: FileMeta, from: string, to: string): FileChange | null {
  return planMergeProperty(file, from, to);
}
export function planDeleteProperty(file: FileMeta, key: string): FileChange | null {
  if (!hasOwn(file.rawFrontmatter, key)) return null;
  const after = cloneFrontmatter(file); delete after[key];
  return fmChange(file, after);
}
export function planAddProperty(file: FileMeta, key: string, value: unknown, _valueType: PropertyValueType, onConflict: ConflictStrategy): FileChange | null {
  const fm = file.rawFrontmatter;
  if (hasOwn(fm, key) && onConflict === 'skip') return null;
  const after = cloneFrontmatter(file);
  if (hasOwn(fm, key) && onConflict === 'append') {
    const existing = fm[key];
    after[key] = Array.isArray(existing) ? [...existing, ...(Array.isArray(value) ? value : [value])] : [existing, value];
  } else after[key] = value;
  return deepEqual(after, fm) ? null : fmChange(file, after);
}
export function planNormalizeDate(file: FileMeta, key: string, target: 'date' | 'datetime', region: RegionFormat): FileChange | null {
  const value = file.rawFrontmatter[key];
  if (typeof value !== 'string') return null;
  const parsed = normalizeDateValue(value, target, region);
  if (!parsed.ok || !parsed.iso || parsed.iso === value) return null;
  const after = cloneFrontmatter(file); after[key] = parsed.iso;
  return fmChange(file, after);
}
export function analyzeOperation(file: FileMeta, operation: ChangeOperation, decision?: PreviewDecision): AnalyzedOperation {
  const result: AnalyzedOperation = { state: 'noop', conflict: false, allowedStrategies: [] };
  if (file.frontmatterParseError) return { ...result, state: 'blocked', reason: 'frontmatter-invalid' };
  const fm = file.rawFrontmatter;
  switch (operation.kind) {
    case 'renameProperty': case 'mergeProperty': {
      const { from, to } = operation;
      if (!hasOwn(fm, from)) return { ...result, reason: 'source-missing' };
      if (from === to) return { ...result, reason: 'already-equal' };
      result.conflict = hasOwn(fm, to) && !deepEqual(fm[from], fm[to]);
      result.allowedStrategies = ['keep-source', 'keep-target', ...(Array.isArray(fm[from]) && Array.isArray(fm[to]) ? ['merge-list' as const] : []), 'skip'];
      if (decision?.merge && !result.allowedStrategies.includes(decision.merge)) throw new OperationError('invalid-decision', file.path);
      if (decision?.merge === 'skip') return { ...result, state: 'conflict', reason: 'policy-skip' };
      result.change = planMergeProperty(file, from, to, decision?.merge) ?? undefined;
      if (!result.change) return { ...result, state: 'conflict', reason: 'conflict-unresolved' };
      break;
    }
    case 'deleteProperty':
      result.change = planDeleteProperty(file, operation.key) ?? undefined;
      result.reason = 'source-missing'; break;
    case 'addProperty':
      result.change = planAddProperty(file, operation.key, operation.value, operation.valueType, operation.onConflict) ?? undefined;
      result.reason = operation.onConflict === 'skip' && hasOwn(fm, operation.key) ? 'policy-skip' : 'already-equal'; break;
    case 'renameTag': case 'mergeTag':
      if (file.tagsComplete === false) return { ...result, state: 'blocked', reason: 'metadata-stale' };
      if (['tag', 'tags'].some(key => hasOwn(fm, key) && fm[key] !== null && typeof fm[key] !== 'string' && !Array.isArray(fm[key]))) return { ...result, state: 'blocked', reason: 'frontmatter-invalid' };
      result.change = planRenameTag(file, operation.from, operation.to) ?? undefined;
      result.reason = operation.from === operation.to ? 'already-equal' : 'source-missing'; break;
    case 'normalizeDate': {
      const value = fm[operation.key];
      if (!hasOwn(fm, operation.key)) return { ...result, reason: 'source-missing' };
      if (typeof value !== 'string') return { ...result, reason: 'date-non-text' };
      const parsed = normalizeDateValue(value, operation.target, operation.regionFormat);
      if (!parsed.ok || !parsed.iso) return { ...result, reason: 'date-unrecognized' };
      if (value === parsed.iso) return { ...result, reason: 'already-normalized' };
      if (parsed.ambiguous) {
        result.ambiguousDate = parsed.iso;
        if (!decision?.dateInterpretationConfirmed) return { ...result, state: 'conflict', reason: 'date-ambiguous' };
      }
      result.change = planNormalizeDate(file, operation.key, operation.target, operation.regionFormat) ?? undefined; break;
    }
  }
  return result.change ? { ...result, state: 'ready', reason: undefined } : result;
}
export function applyTextOps(content: string, ops: readonly TextOp[]): string {
  const sorted = [...ops].sort((a, b) => b.start - a.start);
  let previous = content.length;
  for (const op of sorted) {
    if (!Number.isInteger(op.start) || !Number.isInteger(op.end) || op.start < 0 || op.end <= op.start || op.end > previous
      || content.slice(op.start, op.end) !== op.expect) throw new OperationError('metadata-stale');
    previous = op.start;
  }
  let result = content;
  for (const op of sorted) result = result.slice(0, op.start) + op.replacement + result.slice(op.end);
  return result;
}
