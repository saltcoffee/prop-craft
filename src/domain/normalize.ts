/** Remove a leading '#' and surrounding whitespace. */
export function stripHash(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
}

/** Prefix a normalized tag with '#'. */
export function tagWithHash(normalized: string): string {
  return `#${stripHash(normalized)}`;
}

export function isValidTag(raw: string): boolean {
  const tag = stripHash(raw);
  return tag.length > 0 && /^[\p{L}\p{M}\p{N}\p{S}_/-]+$/u.test(tag) && !/[\s#.,;:!?()[\]{}<>\\`"'=+*&^%$@|]/u.test(tag) && !/^\p{N}+$/u.test(tag);
}

/**
 * Normalize a tag for aggregation and comparison:
 * remove '#', lowercase, fold whitespace/underscore into '-', collapse repeats.
 */
export function normalizeTag(raw: string): string {
  return stripHash(raw)
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

/** Normalize a property key: case-fold only (YAML keys are case-sensitive). */
export function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

/** Conservative English singularization used only for duplicate suggestions. */
export function singularize(word: string): string {
  const s = word.trim();
  if (s.endsWith('ies') && s.length > 4) return `${s.slice(0, -3)}y`;
  if (/(?:ses|xes|ches|shes)$/.test(s)) return s.slice(0, -2);
  if (s.endsWith('s') && !s.endsWith('ss') && s.length > 3) return s.slice(0, -1);
  return s;
}

/** True when two raw tags differ only by case. */
export function differsOnlyByCase(a: string, b: string): boolean {
  return a !== b && a.toLowerCase() === b.toLowerCase();
}

/** True when two raw tags are equal once separators are removed. */
export function differsOnlyBySeparator(a: string, b: string): boolean {
  const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  return a !== b && squash(a) === squash(b);
}

/** Exact tag identity for scope and writes; fuzzy normalization is only a suggestion. */
export function tagIdentity(raw: string): string {
  return stripHash(raw).toLowerCase();
}
