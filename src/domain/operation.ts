import type { ChangeOperation } from './models';
import { isValidTag, isValidTagBranchPrefix, isValidTagPath, tagIdentity } from './normalize';
import { RESERVED_KEYS } from '../constants';
import { OperationError } from './errors';
import { isTypeCompatible } from './type-config';
import { isValueScalar, isValueTarget, EMPTY_STATES, isSafeNumericTarget } from './property-value';

export const KNOWN_OPERATION_KINDS: ReadonlySet<string> = new Set([
  'renameProperty', 'mergeProperty', 'deleteProperty', 'renameTag', 'mergeTag', 'addProperty', 'normalizeDate',
  'mapPropertyValues', 'convertPropertyType', 'migrateTagBranch', 'convertTagsToProperty',
]);

export function isYamlValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || ancestors.has(value) || ancestors.size > 100) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const next = new Set(ancestors).add(value);
  return Object.values(value).every(item => isYamlValue(item, next));
}

function sourceScalar(value: unknown): boolean {
  // Sources come from already-decoded finite values; no safe-integer limit applies to them.
  return isValueScalar(value);
}

function safeScalar(value: unknown): boolean {
  if (!isValueScalar(value)) return false;
  return typeof value.value !== 'number' || isSafeNumericTarget(value.value);
}

function safeTarget(value: unknown): boolean {
  if (!isValueTarget(value)) return false;
  if (value.type === 'list') return value.value.every(safeScalar);
  return safeScalar(value);
}

function validMapOperation(v: Record<string, unknown>): boolean {
  if (!(typeof v.key === 'string' && v.key)) return false;
  if (v.mode !== 'field' && v.mode !== 'member') return false;
  if (!Array.isArray(v.rules)) return false;
  const ids = new Set<string>();
  for (const rule of v.rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
    const r = rule as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id || ids.has(r.id)) return false;
    ids.add(r.id);
    if (!sourceScalar(r.from) || !safeScalar(r.to)) return false;
    if (v.mode === 'field' && isValueScalar(r.from) && r.from.type === 'text' && r.from.value === '') return false;
  }
  const fill = v.fill;
  if (fill !== undefined) {
    if (v.mode === 'member') return false;
    if (!fill || typeof fill !== 'object' || Array.isArray(fill)) return false;
    const f = fill as Record<string, unknown>;
    if (!Array.isArray(f.states) || f.states.some(state => !EMPTY_STATES.includes(state as never))) return false;
    if (new Set(f.states).size !== f.states.length) return false;
    if (!safeTarget(f.target)) return false;
  }
  const hasFill = fill !== undefined && Array.isArray((fill as Record<string, unknown>).states) && ((fill as Record<string, unknown>).states as unknown[]).length > 0;
  return v.rules.length > 0 || hasFill;
}

function validConversion(v: Record<string, unknown>): boolean {
  const conversion = v.conversion;
  if (!conversion || typeof conversion !== 'object' || Array.isArray(conversion)) return false;
  const c = conversion as Record<string, unknown>;
  const sources = v.sources;
  if (!Array.isArray(sources) || sources.length === 0) return false;
  if (!sources.every(sourceScalar)) return false;
  if (new Set(sources.map(source => JSON.stringify(source))).size !== sources.length) return false;
  const onlyText = sources.every(source => isValueScalar(source) && source.type === 'text');
  switch (c.kind) {
    case 'text-to-number': return onlyText;
    case 'wrap-list': return true;
    case 'split-list': {
      if (!onlyText) return false;
      const delimiter = c.delimiter as Record<string, unknown> | undefined;
      if (!delimiter || typeof delimiter !== 'object') return false;
      if (delimiter.kind === 'literal') {
        if (typeof delimiter.value !== 'string' || delimiter.value.length === 0) return false;
      } else if (delimiter.kind !== 'newline') return false;
      return typeof c.trimItems === 'boolean' && typeof c.dropEmptyItems === 'boolean';
    }
    case 'normalize-date':
      return onlyText && (c.target === 'date' || c.target === 'datetime') && ['MDY', 'DMY', 'YMD'].includes(String(c.regionFormat));
    default: return false;
  }
}

function validMigrateTagBranch(v: Record<string, unknown>): boolean {
  if (typeof v.from !== 'string' || typeof v.to !== 'string' || typeof v.includeDescendants !== 'boolean') return false;
  const validPrefix = v.includeDescendants ? isValidTagBranchPrefix : isValidTagPath;
  if (!validPrefix(v.from) || !validPrefix(v.to)) return false;
  const fromId = tagIdentity(v.from);
  const toId = tagIdentity(v.to);
  if (v.includeDescendants && toId.startsWith(`${fromId}/`)) return false;
  return true;
}

function validConvertTagsToProperty(v: Record<string, unknown>): boolean {
  if (typeof v.key !== 'string' || !v.key.trim()) return false;
  if (RESERVED_KEYS.has(v.key.toLowerCase())) return false;
  if (v.mode !== 'scalar' && v.mode !== 'list') return false;
  if (typeof v.removeSourceTags !== 'boolean') return false;
  if (!Array.isArray(v.rules) || v.rules.length === 0) return false;
  const ids = new Set<string>();
  const tagIds = new Set<string>();
  for (const rule of v.rules) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
    const r = rule as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id || ids.has(r.id)) return false;
    ids.add(r.id);
    if (typeof r.tag !== 'string' || !isValidTagPath(r.tag)) return false;
    const tagId = tagIdentity(r.tag);
    if (tagIds.has(tagId)) return false;
    tagIds.add(tagId);
    if (!safeScalar(r.value) || !isYamlValue(r.value)) return false;
  }
  return true;
}

export function isChangeOperation(value: unknown): value is ChangeOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const key = (name: string) => typeof v[name] === 'string' && Boolean(v[name]);
  switch (v.kind) {
    case 'renameProperty': case 'mergeProperty': return key('from') && key('to');
    case 'renameTag': case 'mergeTag': return key('from') && key('to') && isValidTag(v.from as string) && isValidTag(v.to as string);
    case 'deleteProperty': return key('key');
    case 'normalizeDate': return key('key') && ['date', 'datetime'].includes(String(v.target)) && ['MDY', 'DMY', 'YMD'].includes(String(v.regionFormat));
    case 'addProperty': return key('key') && ['text', 'number', 'checkbox', 'list', 'date', 'datetime'].includes(String(v.valueType))
      && ['skip', 'overwrite', 'append'].includes(String(v.onConflict)) && isYamlValue(v.value) && isTypeCompatible(String(v.valueType), v.value);
    case 'mapPropertyValues': return validMapOperation(v);
    case 'convertPropertyType': return key('key') && validConversion(v);
    case 'migrateTagBranch': return validMigrateTagBranch(v);
    case 'convertTagsToProperty': return validConvertTagsToProperty(v);
    default: return false;
  }
}

export function validateOperation(operation: ChangeOperation): void {
  if (operation.kind === 'migrateTagBranch') {
    if (typeof operation.from !== 'string' || typeof operation.to !== 'string' || typeof operation.includeDescendants !== 'boolean') {
      throw new OperationError('input-invalid');
    }
    const validPrefix = operation.includeDescendants ? isValidTagBranchPrefix : isValidTagPath;
    if (!validPrefix(operation.from) || !validPrefix(operation.to)) {
      throw new OperationError('tag-path-invalid');
    }
    const fromId = tagIdentity(operation.from);
    const toId = tagIdentity(operation.to);
    if (operation.includeDescendants && toId.startsWith(`${fromId}/`)) {
      throw new OperationError('tag-descendant-target');
    }
    return;
  }
  if (operation.kind === 'convertTagsToProperty') {
    if (typeof operation.key !== 'string' || !operation.key.trim()) throw new OperationError('input-invalid');
    if (RESERVED_KEYS.has(operation.key.toLowerCase())) throw new OperationError('reserved-key');
    if (operation.mode !== 'scalar' && operation.mode !== 'list') throw new OperationError('input-invalid');
    if (typeof operation.removeSourceTags !== 'boolean') throw new OperationError('input-invalid');
    const rawRules: unknown = operation.rules;
    if (!Array.isArray(rawRules) || rawRules.length === 0) throw new OperationError('input-invalid');
    const rulesList: readonly unknown[] = rawRules;
    const ids = new Set<string>();
    const tagIds = new Set<string>();
    for (const rawRule of rulesList) {
      if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) throw new OperationError('input-invalid');
      const rule = rawRule as Record<string, unknown>;
      if (typeof rule.id !== 'string' || !rule.id) throw new OperationError('input-invalid');
      if (ids.has(rule.id)) throw new OperationError('tag-rule-duplicate');
      ids.add(rule.id);
      if (typeof rule.tag !== 'string' || !isValidTagPath(rule.tag)) throw new OperationError('tag-path-invalid');
      const tagId = tagIdentity(rule.tag);
      if (tagIds.has(tagId)) throw new OperationError('tag-rule-duplicate');
      tagIds.add(tagId);
      if (!isValueScalar(rule.value)) throw new OperationError('input-invalid');
      if (rule.value.type === 'number' && !isSafeNumericTarget(rule.value.value)) throw new OperationError('number-precision');
    }
    return;
  }
  if (!isChangeOperation(operation)) throw new OperationError('input-invalid');
  const keys = operation.kind === 'renameProperty' || operation.kind === 'mergeProperty'
    ? [operation.from, operation.to]
    : 'key' in operation ? [operation.key] : [];
  if (keys.some(key => RESERVED_KEYS.has(key.toLowerCase()))) throw new OperationError('reserved-key');
}
