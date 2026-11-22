import type { ChangeOperation, ConflictStrategy, ConvertPropertyTypeOperation, FileChange, FileMeta, MergeStrategy, PropertyValueType, RegionFormat, TextOp } from './models';
import type { AnalyzedOperation, PreviewDecision, ValueAnalysis, ValueConfirmation } from './preview';
import { isValidTag, tagIdentity, stripHash, tagWithHash } from './normalize';
import { normalizeDateValue } from './date';
import { hasOwn } from './scope';
import { OperationError } from './errors';
import { isTypeCompatible } from './type-config';
import { analyzeConversion } from './value-conversion';
import { analyzeValueMapping, compileValueMapping, type CompiledValueMapping } from './value-mapping';
import { scalarFromRaw, scalarIdentity } from './property-value';
import { parseFrontmatterTags } from './frontmatter-tags';
import { analyzeTagBranch, compileTagBranch } from './tag-migration';
import { analyzeTagProperty, compileTagProperty } from './tag-property';

export interface ValueAnalyzeContext {
  mapping?: CompiledValueMapping;
  declaration?: { kind: 'known'; type: string } | { kind: 'absent' } | { kind: 'unavailable' };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return a !== 0 || Object.is(a, b);
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
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
export function rewriteFrontmatterTag(fm: Record<string, unknown>, from: string, to: string, key: 'tags' | 'tag' = 'tags'): { key: 'tags' | 'tag'; value: unknown } | null {
  if (!hasOwn(fm, key)) return null;
  const raw = fm[key];
  if (isUnknownArray(raw)) {
    const mapped = raw.map((entry): unknown => typeof entry === 'string' ? rewriteTagEntry(entry, from, to) : entry);
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
    const existing: unknown = fm[key];
    after[key] = isUnknownArray(existing)
      ? [...existing, ...(isUnknownArray(value) ? value : [value])]
      : [existing, value];
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
const CONFIRMATION_FLAG: Record<ValueConfirmation, 'valueLossConfirmed' | 'declaredTypeMismatchConfirmed' | 'dateInterpretationConfirmed'> = {
  'value-loss': 'valueLossConfirmed',
  'declared-type-mismatch': 'declaredTypeMismatchConfirmed',
  'date-interpretation': 'dateInterpretationConfirmed',
};
function isConfirmed(confirmation: ValueConfirmation, decision?: PreviewDecision): boolean {
  return Boolean(decision?.[CONFIRMATION_FLAG[confirmation]]);
}
function analyzeConversionForFile(file: FileMeta, operation: ConvertPropertyTypeOperation): ValueAnalysis {
  const fm = file.rawFrontmatter;
  if (!hasOwn(fm, operation.key)) return { outcome: 'noop', ruleIds: [], issues: [{ code: 'source-missing' }], requiredConfirmations: [] };
  const raw = fm[operation.key];
  const scalar = scalarFromRaw(raw);
  const selected = new Set(operation.sources.map(scalarIdentity));
  if (!scalar || !selected.has(scalarIdentity(scalar))) {
    return { outcome: 'noop', ruleIds: [], issues: [{ code: 'value-source-unselected' }], requiredConfirmations: [] };
  }
  return analyzeConversion(raw, operation.conversion);
}
function finishValue(file: FileMeta, operation: { key: string }, analysis: ValueAnalysis, decision: PreviewDecision | undefined, context: ValueAnalyzeContext | undefined): AnalyzedOperation {
  const result: AnalyzedOperation = { state: 'noop', conflict: false, allowedStrategies: [], valueAnalysis: analysis };
  if (file.metadataStatus === 'unavailable') return { ...result, state: 'blocked', reason: 'metadata-stale' };
  const required = [...analysis.requiredConfirmations];
  const issues = [...analysis.issues];
  const hasCandidate = analysis.outcome !== 'unconvertible' && analysis.outcome !== 'noop' && analysis.candidate !== undefined;
  if (hasCandidate) {
    const declaration = context?.declaration;
    if (declaration?.kind === 'unavailable') return { ...result, state: 'blocked', reason: 'type-config-unsupported' };
    if (declaration?.kind === 'known' && !isTypeCompatible(declaration.type, analysis.candidate)) {
      if (!required.includes('declared-type-mismatch')) required.push('declared-type-mismatch');
      if (!issues.some(item => item.code === 'declared-type-mismatch')) issues.push({ code: 'declared-type-mismatch' });
    }
    const after = cloneFrontmatter(file);
    after[operation.key] = analysis.candidate;
    result.change = fmChange(file, after);
  }
  result.valueAnalysis = { ...analysis, requiredConfirmations: required, issues };
  if (analysis.outcome === 'unconvertible') { result.state = 'blocked'; result.reason = issues[0]?.code ?? 'value-unsupported'; return result; }
  if (analysis.outcome === 'noop' || !result.change) { result.state = 'noop'; result.reason = issues[0]?.code ?? 'no-change'; return result; }
  if (required.some(confirmation => !isConfirmed(confirmation, decision))) {
    result.state = 'conflict';
    result.conflict = true;
    result.reason = issues[0]?.code ?? 'declared-type-mismatch';
    return result;
  }
  result.state = 'ready';
  return result;
}
export function analyzeOperation(file: FileMeta, operation: ChangeOperation, decision?: PreviewDecision, context?: ValueAnalyzeContext): AnalyzedOperation {
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
      // Share the full risk analysis with the workbench conversion so the legacy entry cannot
      // silently drop time/seconds, add 00:00, or assume a two-digit year.
      const analysis = analyzeConversion(value, { kind: 'normalize-date', target: operation.target, regionFormat: operation.regionFormat });
      result.valueAnalysis = analysis;
      if (analysis.outcome === 'unconvertible') return { ...result, state: 'blocked', reason: analysis.issues[0]?.code ?? 'date-unrecognized' };
      if (analysis.outcome === 'noop') return { ...result, reason: analysis.issues[0]?.code ?? 'already-normalized' };
      if (analysis.requiredConfirmations.includes('date-interpretation')) result.ambiguousDate = String(analysis.candidate ?? '');
      result.change = planNormalizeDate(file, operation.key, operation.target, operation.regionFormat) ?? undefined;
      if (!result.change) return { ...result, reason: 'already-normalized' };
      const unmet = analysis.requiredConfirmations.filter(confirmation => !isConfirmed(confirmation, decision));
      if (unmet.length) {
        result.state = 'conflict';
        result.conflict = true;
        result.reason = unmet.includes('date-interpretation') ? 'date-ambiguous' : 'date-value-loss';
        return result;
      }
      return { ...result, state: 'ready', reason: undefined };
    }
    case 'mapPropertyValues': {
      const compiled = context?.mapping ?? compileValueMapping(operation);
      return finishValue(file, operation, analyzeValueMapping(file, operation, compiled), decision, context);
    }
    case 'convertPropertyType':
      return finishValue(file, operation, analyzeConversionForFile(file, operation), decision, context);
    case 'migrateTagBranch': {
      const compiled = compileTagBranch(operation);
      const analyzed = analyzeTagBranch(file, compiled, parseFrontmatterTags(file.rawFrontmatter));
      return { ...result, state: analyzed.state, reason: analyzed.reason, change: analyzed.change };
    }
    case 'convertTagsToProperty': {
      const compiled = compileTagProperty(operation);
      const analyzed = analyzeTagProperty(file, compiled, parseFrontmatterTags(file.rawFrontmatter));
      if (analyzed.baseState === 'blocked') return { ...result, state: 'blocked', reason: analyzed.reason };
      if (analyzed.baseState === 'noop') return { ...result, state: 'noop', reason: analyzed.reason };
      if (analyzed.requiresResolution) {
        const res = decision?.tagPropertyResolution;
        if (!res) return { ...result, state: 'conflict', conflict: true, reason: analyzed.reason };
        if (res.kind === 'keep-existing' || res.kind === 'skip') return { ...result, state: 'conflict', conflict: true, reason: 'policy-skip' };
        const chosen = analyzed.candidates.find(c =>
          res.kind === 'replace-list' ? c.resolution.kind === 'replace-list' : c.ruleIds.includes(res.ruleId),
        );
        if (!chosen) throw new OperationError('invalid-decision', file.path);
        return { ...result, state: 'ready', change: chosen.change };
      }
      return { ...result, state: 'ready', change: analyzed.candidates[0]?.change };
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
