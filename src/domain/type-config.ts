import { parseDate } from './date';
export interface TypePatch {
  configBeforeContent: string;
  configBeforeHash: string;
  configAfterContent: string;
  configAfterHash: string;
  sourceKey: string;
  targetKey: string;
  targetAfter: string;
}
export type TypeDeclarations =
  | { kind: 'ready'; raw: string | null; declarations: ReadonlyMap<string, string> }
  | { kind: 'unsupported'; raw?: string };

export function isKnownPropertyType(type: string): boolean {
  return ['text', 'number', 'checkbox', 'list', 'multitext', 'date', 'datetime'].includes(type);
}
export function isTypeCompatible(type: string | undefined, value: unknown): boolean {
  if (!type) return true;
  if (!isKnownPropertyType(type)) return false;
  if (value === null) return true;
  switch (type) {
    case 'text': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'checkbox': return typeof value === 'boolean';
    case 'list': case 'multitext': return Array.isArray(value);
    case 'date': return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && parseDate(value, 'YMD').iso === value;
    case 'datetime': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) return false;
      if (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || value[16] === ':' && Number(value.slice(17, 19)) > 59) return false;
      const date = value.slice(0, 10);
      return parseDate(date, 'YMD').iso === date && Number.isFinite(Date.parse(value));
    }
    default: return false;
  }
}
