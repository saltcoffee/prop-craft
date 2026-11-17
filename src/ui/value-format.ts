import type { ValueScalar } from '../domain/models';
import { scalarToRaw } from '../domain/property-value';

/** Show a decoded value with quotes/escapes so visible whitespace is not lost. */
export function displayValue(raw: unknown): string {
  if (raw === undefined) return '—';
  if (typeof raw === 'string') return JSON.stringify(raw);
  if (raw === null) return 'null';
  return JSON.stringify(raw);
}

export function displayScalar(scalar: ValueScalar): string {
  return displayValue(scalarToRaw(scalar));
}
