import type { ChangeOperation } from './models';
import { isValidTag } from './normalize';
import { RESERVED_KEYS } from '../constants';
import { OperationError } from './errors';
import { isTypeCompatible } from './type-config';

export function isYamlValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || ancestors.has(value) || ancestors.size > 100) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const next = new Set(ancestors).add(value);
  return Object.values(value).every(item => isYamlValue(item, next));
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
    default: return false;
  }
}
export function validateOperation(operation: ChangeOperation): void {
  if (!isChangeOperation(operation)) throw new OperationError('input-invalid');
  const keys = operation.kind === 'renameProperty' || operation.kind === 'mergeProperty'
    ? [operation.from, operation.to]
    : 'key' in operation ? [operation.key] : [];
  if (keys.some(key => RESERVED_KEYS.has(key.toLowerCase()))) throw new OperationError('reserved-key');
}
