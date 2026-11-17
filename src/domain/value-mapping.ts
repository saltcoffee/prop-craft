import type { ChangeOperation, FillSpec, MapPropertyValuesOperation, ValueMappingRule } from './models';
import type { ValueAnalysis } from './preview';
import { OperationError } from './errors';
import type { IssueCode } from './errors';
import {
  classifyField, scalarFromRaw, scalarIdentity, scalarToRaw, valueIdentity, valueTargetToRaw,
  actualValueType, EMPTY_STATES, isValueScalar, isValueTarget, type EmptyState, type ValueScalar, type ValueTarget,
} from './property-value';
import { containsLink } from './value-conversion';

export interface CompiledValueMapping {
  rules: Map<string, { ruleId: string; to: ValueScalar }>;
  fill?: { states: Set<EmptyState>; target: ValueTarget };
}

export interface MappingIssue { code: IssueCode; ruleId?: string }

function ruleIdentity(rule: ValueMappingRule): string {
  return scalarIdentity(rule.from);
}

function targetListSafe(target: ValueTarget): boolean {
  if (target.type !== 'list') return true;
  return target.value.every(item => typeof item.value !== 'number' || Number.isFinite(item.value));
}

/** Structural + semantic validation used by the editor before a preview is requested. */
export function validateValueMapping(operation: MapPropertyValuesOperation): MappingIssue[] {
  const issues: MappingIssue[] = [];
  const seen = new Map<string, string>();
  for (const rule of operation.rules) {
    if (!isValueScalar(rule.from) || !isValueScalar(rule.to)) { issues.push({ code: 'input-invalid', ruleId: rule.id }); continue; }
    if (operation.mode === 'field' && rule.from.type === 'text' && rule.from.value === '') {
      issues.push({ code: 'input-invalid', ruleId: rule.id });
    }
    const identity = ruleIdentity(rule);
    const previous = seen.get(identity);
    if (previous !== undefined && previous !== scalarIdentity(rule.to)) issues.push({ code: 'mapping-source-conflict', ruleId: rule.id });
    else seen.set(identity, scalarIdentity(rule.to));
  }
  const fill = (operation as { fill?: FillSpec }).fill;
  if (fill) {
    if (!Array.isArray(fill.states) || fill.states.some(state => !EMPTY_STATES.includes(state)) || !isValueTarget(fill.target) || !targetListSafe(fill.target)) {
      issues.push({ code: 'input-invalid' });
    }
  }
  if (!operation.rules.length && !(fill && fill.states.length)) issues.push({ code: 'input-invalid' });
  if (issues.length) return issues;
  // Idempotency: every produced target must already be a fixed point of F.
  const table = new Map<string, string>();
  for (const rule of operation.rules) table.set(ruleIdentity(rule), scalarIdentity(rule.to));
  for (const rule of operation.rules) {
    const produced = scalarIdentity(rule.to);
    const next = table.get(produced);
    if (next !== undefined && next !== produced) issues.push({ code: 'mapping-non-idempotent', ruleId: rule.id });
  }
  if (fill && fill.target.type !== 'list') {
    const produced = scalarIdentity(fill.target);
    const next = table.get(produced);
    if (next !== undefined && next !== produced) issues.push({ code: 'mapping-non-idempotent' });
  }
  // A rule that produces empty text changes again only if fill would rewrite empty text to a
  // different value; filling it back to empty text is already a stable fixed point.
  if (fill && fill.states.includes('empty-text')) {
    const stableEmpty = valueIdentity(valueTargetToRaw(fill.target)) === valueIdentity('');
    if (!stableEmpty) {
      for (const rule of operation.rules) {
        if (rule.to.type === 'text' && rule.to.value === '') issues.push({ code: 'mapping-non-idempotent', ruleId: rule.id });
      }
    }
  }
  return issues;
}

export function compileValueMapping(operation: MapPropertyValuesOperation): CompiledValueMapping {
  const issues = validateValueMapping(operation);
  if (issues.length) throw new OperationError(issues[0].code);
  const compiled: CompiledValueMapping = { rules: new Map() };
  for (const rule of operation.rules) compiled.rules.set(ruleIdentity(rule), { ruleId: rule.id, to: rule.to });
  const fill = (operation as { fill?: FillSpec }).fill;
  if (fill && fill.states.length) compiled.fill = { states: new Set(fill.states), target: fill.target };
  return compiled;
}

function analysis(outcome: ValueAnalysis['outcome'], extra: Partial<ValueAnalysis> = {}): ValueAnalysis {
  return { outcome, ruleIds: [], issues: [], requiredConfirmations: [], ...extra };
}

function applyMemberRules(array: readonly unknown[], compiled: CompiledValueMapping): unknown[] | null {
  const mapped: unknown[] = [];
  const targetIdentities = new Set<string>();
  let changed = false;
  for (const item of array) {
    const scalar = scalarFromRaw(item);
    if (!scalar) { mapped.push(item); continue; }
    const rule = compiled.rules.get(scalarIdentity(scalar));
    if (!rule) { mapped.push(item); continue; }
    const targetIdentity = scalarIdentity(rule.to);
    // A rule that maps a value to itself is not a real replacement and must not feed dedupe.
    if (targetIdentity === scalarIdentity(scalar)) { mapped.push(item); continue; }
    changed = true;
    targetIdentities.add(targetIdentity);
    mapped.push(scalarToRaw(rule.to));
  }
  if (!changed) return null;
  // Only dedupe members whose target was actually produced by this replacement.
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const item of mapped) {
    const identity = valueIdentity(item);
    if (targetIdentities.has(identity)) {
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    result.push(item);
  }
  return result;
}

/** Pure per-file analysis. Returns a candidate value in `analysis.candidate`; change building is external. */
export function analyzeValueMapping(file: import('./models').FileMeta, operation: MapPropertyValuesOperation, compiled: CompiledValueMapping): ValueAnalysis {
  const raw = file.rawFrontmatter[operation.key];
  const beforeType = raw === undefined ? undefined : actualValueType(raw);
  if (operation.mode === 'member') {
    if (!Array.isArray(raw)) return analysis('noop', { beforeType, issues: [{ code: 'value-unsupported' }] });
    const result = applyMemberRules(raw, compiled);
    if (!result) return analysis('noop', { beforeType: 'list', issues: [{ code: 'value-source-unselected' }] });
    if (valueIdentity(result) === valueIdentity(raw)) return analysis('noop', { beforeType: 'list', issues: [{ code: 'already-equal' }] });
    return analysis('ready', { beforeType: 'list', afterType: 'list', candidate: result });
  }
  const state = classifyField(file.rawFrontmatter, operation.key);
  if (state === 'missing' || state === 'null' || state === 'empty-text' || state === 'empty-list') {
    if (compiled.fill && compiled.fill.states.has(state)) {
      const targetRaw = valueTargetToRaw(compiled.fill.target);
      return analysis('ready', {
        beforeType: state === 'missing' ? undefined : actualValueType(raw),
        afterType: compiled.fill.target.type === 'list' ? 'list' : compiled.fill.target.type,
        candidate: targetRaw,
      });
    }
    return analysis('noop', { beforeType, issues: [{ code: 'already-equal' }] });
  }
  const scalar = scalarFromRaw(raw);
  if (!scalar) return analysis('noop', { beforeType, issues: [{ code: 'value-unsupported' }] });
  const rule = compiled.rules.get(scalarIdentity(scalar));
  if (!rule) return analysis('noop', { beforeType, issues: [{ code: 'value-source-unselected' }] });
  if (scalarIdentity(rule.to) === scalarIdentity(scalar)) return analysis('noop', { beforeType, issues: [{ code: 'already-equal' }] });
  return analysis('ready', { beforeType, afterType: rule.to.type, candidate: scalarToRaw(rule.to), ruleIds: [rule.ruleId] });
}

export interface TextSuggestionOptions { trim: boolean; caseMode: 'none' | 'lower' | 'upper' }

/** Expand explicit rules from selected text values; values containing links are never rewritten. */
export function suggestTextMappings(selected: readonly ValueScalar[], options: TextSuggestionOptions): { rules: ValueMappingRule[]; linked: ValueScalar[] } {
  const rules: ValueMappingRule[] = [];
  const linked: ValueScalar[] = [];
  let index = 0;
  for (const value of selected) {
    if (value.type !== 'text') continue;
    if (containsLink(value.value)) { linked.push(value); continue; }
    let next = value.value;
    if (options.trim) next = next.trim();
    if (options.caseMode === 'lower') next = next.toLowerCase();
    else if (options.caseMode === 'upper') next = next.toUpperCase();
    if (next === value.value) continue;
    rules.push({ id: `suggest-${index++}`, from: value, to: { type: 'text', value: next } });
  }
  return { rules, linked };
}

export function isMapValueOperation(operation: ChangeOperation): operation is MapPropertyValuesOperation {
  return operation.kind === 'mapPropertyValues';
}
