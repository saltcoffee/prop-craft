import { hasOwn } from './scope';

/** Actual storage type inferred only from the decoded raw value (never the declaration). */
export type ActualValueType = 'text' | 'number' | 'boolean' | 'list' | 'null' | 'object';

/** Empty-ish states that can be filled explicitly. Whitespace is tracked separately. */
export type EmptyState = 'missing' | 'null' | 'empty-text' | 'empty-list';
export type FieldState = EmptyState | 'whitespace' | 'nonempty';

export interface ValueScalarText { type: 'text'; value: string }
export interface ValueScalarNumber { type: 'number'; value: number }
export interface ValueScalarBoolean { type: 'boolean'; value: boolean }
export type ValueScalar = ValueScalarText | ValueScalarNumber | ValueScalarBoolean;
export interface ValueList { type: 'list'; value: readonly ValueScalar[] }
export type ValueTarget = ValueScalar | ValueList;

export const EMPTY_STATES: readonly EmptyState[] = ['missing', 'null', 'empty-text', 'empty-list'];
export const FIELD_STATES: readonly FieldState[] = ['missing', 'null', 'empty-text', 'empty-list', 'whitespace', 'nonempty'];
export const ACTUAL_TYPES: readonly ActualValueType[] = ['text', 'number', 'boolean', 'list', 'null', 'object'];

/** Classify a decoded value without interpreting strings as dates. Arrays win over objects. */
export function actualValueType(raw: unknown): ActualValueType {
  if (raw === null || raw === undefined) return 'null';
  if (Array.isArray(raw)) return 'list';
  if (typeof raw === 'string') return 'text';
  if (typeof raw === 'number') return 'number';
  if (typeof raw === 'boolean') return 'boolean';
  return 'object';
}

export function classifyField(frontmatter: Record<string, unknown>, key: string): FieldState {
  if (!hasOwn(frontmatter, key)) return 'missing';
  const raw = frontmatter[key];
  if (raw === null) return 'null';
  if (typeof raw === 'string') {
    if (raw.length === 0) return 'empty-text';
    return raw.trim().length === 0 ? 'whitespace' : 'nonempty';
  }
  if (Array.isArray(raw)) return raw.length === 0 ? 'empty-list' : 'nonempty';
  return 'nonempty';
}

function canonical(raw: unknown): unknown {
  if (raw === null || raw === undefined) return ['null'];
  if (typeof raw === 'string') return ['text', raw];
  if (typeof raw === 'number') return ['number', Object.is(raw, -0) ? '-0' : String(raw)];
  if (typeof raw === 'boolean') return ['boolean', raw];
  if (Array.isArray(raw)) return ['list', ...raw.map(canonical)];
  if (typeof raw === 'object') {
    const object = raw as Record<string, unknown>;
    // Proto-less iteration and sorted keys keep identity stable and free of prototype keys.
    const keys = Object.keys(object).sort();
    return ['object', ...keys.map(key => [key, canonical(object[key])])];
  }
  return ['unknown', String(raw)];
}

/** Recursive typed identity: "5", 5, [5] and missing are all distinct. */
export function valueIdentity(raw: unknown): string {
  return JSON.stringify(canonical(raw));
}

export function isValueScalar(value: unknown): value is ValueScalar {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === 'text') return typeof candidate.value === 'string';
  if (candidate.type === 'number') return typeof candidate.value === 'number' && Number.isFinite(candidate.value);
  if (candidate.type === 'boolean') return typeof candidate.value === 'boolean';
  return false;
}

export function isValueTarget(value: unknown): value is ValueTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.type === 'list') return Array.isArray(candidate.value) && candidate.value.every(isValueScalar);
  return isValueScalar(value);
}

/** Convert a decoded raw scalar into an explicit typed scalar, or null when unsupported. */
export function scalarFromRaw(raw: unknown): ValueScalar | null {
  if (typeof raw === 'string') return { type: 'text', value: raw };
  if (typeof raw === 'number' && Number.isFinite(raw)) return { type: 'number', value: raw };
  if (typeof raw === 'boolean') return { type: 'boolean', value: raw };
  return null;
}

export function scalarToRaw(scalar: ValueScalar): string | number | boolean {
  return scalar.value;
}

export function valueTargetToRaw(target: ValueTarget): unknown {
  return target.type === 'list' ? target.value.map(item => item.value) : target.value;
}

export function scalarIdentity(scalar: ValueScalar): string {
  return valueIdentity(scalarToRaw(scalar));
}

/** Safest integer check used for persisted numeric targets. */
export function isSafeNumericTarget(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (!Number.isInteger(value)) return true;
  return Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}
