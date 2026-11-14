import type { FileMeta, PropertyValue, PropertyValueType, TagOccurrence } from '../domain/models';
import { normalizeTag } from '../domain/normalize';
import { RESERVED_KEYS } from '../constants';
import type { CachedMeta } from '../ports/VaultPort';

function inferredType(value: unknown): PropertyValueType {
  return Array.isArray(value) ? 'list' : typeof value === 'string' ? 'text' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'checkbox' : 'unknown';
}
export function fileMeta(path: string, mtime: number, cache: CachedMeta | null, types: ReadonlyMap<string, string> = new Map()): FileMeta {
  const fm = cache?.frontmatter ?? {};
  const properties: Record<string, PropertyValue> = Object.create(null) as Record<string, PropertyValue>;
  for (const [key, raw] of Object.entries(fm)) {
    if (RESERVED_KEYS.has(key.toLowerCase())) continue;
    const declared = types.get(key.toLowerCase());
    const type = declared === 'multitext' ? 'list' : declared;
    const recognized = ['text', 'list', 'number', 'checkbox', 'date', 'datetime'].includes(type ?? '') ? type as PropertyValueType : inferredType(raw);
    properties[key] = { raw, type: recognized, valueCount: Array.isArray(raw) ? raw.length : 1 };
  }
  const tags = new Map<string, TagOccurrence>();
  const add = (raw: string, origin: 'frontmatter' | 'body', position?: { start: number; end: number }) => {
    const tag = raw.startsWith('#') ? raw : `#${raw}`;
    let entry = tags.get(tag);
    if (!entry) { entry = { tag, normalized: normalizeTag(tag), origin, positions: [] }; tags.set(tag, entry); }
    else if (entry.origin !== origin) entry.origin = 'both';
    if (position) entry.positions.push(position);
  };
  let tagsComplete = Boolean(cache) && !cache?.frontmatterParseError;
  for (const key of ['tags', 'tag']) {
    const value = fm[key];
    if (typeof value === 'string') for (const part of value.split(',')) { if (part.trim()) add(part.trim(), 'frontmatter'); }
    else if (Array.isArray(value)) { for (const part of value) if (typeof part === 'string' && part.trim()) add(part.trim(), 'frontmatter'); }
    else if (value !== null && value !== undefined) tagsComplete = false;
  }
  for (const tag of cache?.bodyTags ?? []) add(tag.tag, 'body', tag);
  return { path, mtime, hasValidFrontmatter: Boolean(cache?.frontmatter), frontmatterParseError: cache?.frontmatterParseError ?? false,
    metadataStatus: cache ? 'ready' : 'unavailable', tagsComplete, rawFrontmatter: structuredClone(fm), properties, tags: [...tags.values()] };
}
