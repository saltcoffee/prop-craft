import type { TypeCodecResult, TypeConfigCodecPort } from '../ports/TypeConfigCodecPort';
import { hasOwn } from '../domain/scope';

/** The native { types: { key: widget } } layout, preserving unrelated config. */
export class ObsidianTypeConfigCodec implements TypeConfigCodecPort {
  private parse(raw: string): { types: Record<string, string>; [key: string]: unknown } | null {
    try {
      const value: unknown = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const types = (value as Record<string, unknown>).types;
      if (!types || typeof types !== 'object' || Array.isArray(types) || Object.values(types).some(type => typeof type !== 'string')) return null;
      return value as { types: Record<string, string>; [key: string]: unknown };
    } catch { return null; }
  }
  readDeclarations(raw: string): TypeCodecResult<ReadonlyMap<string, string>> {
    const value = this.parse(raw);
    return value ? { ok: true, value: new Map(Object.entries(value.types)) } : { ok: false };
  }
  addTarget(raw: string, key: string, type: string): TypeCodecResult<string> {
    const value = this.parse(raw);
    if (!value || hasOwn(value.types, key)) return { ok: false };
    Object.defineProperty(value.types, key, { value: type, enumerable: true, configurable: true, writable: true });
    return { ok: true, value: `${JSON.stringify(value, null, 2)}\n` };
  }
  removeTarget(raw: string, key: string, expectedType: string): TypeCodecResult<string> {
    const value = this.parse(raw);
    if (!value || !hasOwn(value.types, key) || value.types[key] !== expectedType) return { ok: false };
    delete value.types[key];
    return { ok: true, value: `${JSON.stringify(value, null, 2)}\n` };
  }
}
