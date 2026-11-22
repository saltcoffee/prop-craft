import type { ValueScalar } from '../domain/models';
import { serializeJournalJson } from '../domain/journal';
import { scalarToRaw } from '../domain/property-value';

/** Show a decoded value with quotes/escapes and -0 sign preserved. */
export function displayValue(raw: unknown): string {
  if (raw === undefined) return '—';
  if (raw === null) return 'null';
  return serializeJournalJson(raw);
}

export function displayScalar(scalar: ValueScalar): string {
  return displayValue(scalarToRaw(scalar));
}
