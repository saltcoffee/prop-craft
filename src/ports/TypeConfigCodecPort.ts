export type TypeCodecResult<T> = { ok: true; value: T } | { ok: false };
export interface TypeConfigCodecPort {
  readDeclarations(raw: string): TypeCodecResult<ReadonlyMap<string, string>>;
  addTarget(raw: string, key: string, type: string): TypeCodecResult<string>;
  removeTarget(raw: string, key: string, expectedType: string): TypeCodecResult<string>;
}
