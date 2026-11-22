import { OperationError } from './errors';

/** Single character allowed inside a complete tag token; shared with the body parser. */
export const TAG_TOKEN_CHAR_SOURCE = '(?:(?![#$+<=>^`|~])[\\p{L}\\p{M}\\p{N}\\p{S}_/-])';
export const TAG_TOKEN_SCAN_REGEX = new RegExp(`#${TAG_TOKEN_CHAR_SOURCE}+`, 'gu');
const COMPLETE_TAG_TOKEN_REGEX = new RegExp(`^#${TAG_TOKEN_CHAR_SOURCE}+$`, 'u');

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
 * True only when the whole string (with leading '#') is recognized as a single complete tag token
 * under the character rules shared with Markdown body tag scanning.
 */
export function isCompleteTagToken(tag: string): boolean {
  return tag.length >= 2 && COMPLETE_TAG_TOKEN_REGEX.test(tag) && !/^#\p{N}+$/u.test(tag);
}

/**
 * Validate and normalize a tag branch prefix (with leading '#').
 * Shares token character and non-empty segment rules with `validateTagPath`,
 * while allowing pure-numeric virtual parent prefixes such as `#2026` for descendant branches.
 */
export function validateTagBranchPrefix(raw: string): string {
  if (typeof raw !== 'string') throw new OperationError('tag-path-invalid');
  const trimmed = raw.trim();
  if (!trimmed) throw new OperationError('tag-path-invalid');
  const body = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (!body) throw new OperationError('tag-path-invalid');
  const normalized = `#${body}`;
  if (normalized.length < 2 || !COMPLETE_TAG_TOKEN_REGEX.test(normalized)) {
    throw new OperationError('tag-path-invalid');
  }
  const segments = body.split('/');
  if (segments.some(segment => segment.length === 0)) throw new OperationError('tag-path-invalid');
  return normalized;
}

export function isValidTagBranchPrefix(raw: string): boolean {
  try {
    validateTagBranchPrefix(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate and normalize a full tag path (with leading '#'), rejecting empty segments,
 * leading/trailing slashes, whitespace, and characters not recognized as a single tag token.
 */
export function validateTagPath(raw: string): string {
  const normalized = validateTagBranchPrefix(raw);
  if (!isCompleteTagToken(normalized)) throw new OperationError('tag-path-invalid');
  return normalized;
}

export function isValidTagPath(raw: string): boolean {
  try {
    validateTagPath(raw);
    return true;
  } catch {
    return false;
  }
}

/** Split a tag into original-case path segments without leading '#'. */
export function splitTagSegments(raw: string): string[] {
  return stripHash(raw).split('/');
}

/** Segment-boundary branch membership test using exact case-insensitive tag identity. */
export function isTagInBranch(tag: string, root: string, includeDescendants: boolean): boolean {
  const id = tagIdentity(tag);
  const rootId = tagIdentity(root);
  if (!id || !rootId) return false;
  return id === rootId || (includeDescendants && id.startsWith(`${rootId}/`));
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
