import { hasOwn } from './scope';
import { isValidTagPath, stripHash, tagIdentity, tagWithHash } from './normalize';

export type TagContainerKey = 'tags' | 'tag';
export type TagContainerShape = 'absent' | 'empty' | 'array' | 'single-string' | 'comma-string' | 'unsupported';

export interface FrontmatterTagEntry {
  key: TagContainerKey;
  /** Original string member in the container (may or may not have leading '#'). */
  raw: string;
  /** Tag with leading '#' preserving original case. */
  tag: string;
  /** Lowercased identity without leading '#'. */
  id: string;
  hasHash: boolean;
  /** Slot index in array or comma-separated list. */
  index: number;
}

export type ArraySlot =
  | { kind: 'tag'; entry: FrontmatterTagEntry }
  | { kind: 'non-string'; raw: unknown }
  | { kind: 'empty-string'; raw: string };

export interface ParsedTagContainer {
  key: TagContainerKey;
  shape: TagContainerShape;
  complete: boolean;
  entries: readonly FrontmatterTagEntry[];
  slots: readonly ArraySlot[];
  hasNonStringMembers: boolean;
}

export interface ParsedTagContainers {
  tags: ParsedTagContainer;
  tag: ParsedTagContainer;
  complete: boolean;
  unsupportedKeys: readonly TagContainerKey[];
  entries: readonly FrontmatterTagEntry[];
}

export type FrontmatterTagAction =
  | { kind: 'keep' }
  | { kind: 'replace'; to: string }
  | { kind: 'remove' };

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function parseContainer(frontmatter: Readonly<Record<string, unknown>>, key: TagContainerKey): ParsedTagContainer {
  if (!hasOwn(frontmatter, key)) {
    return { key, shape: 'absent', complete: true, entries: [], slots: [], hasNonStringMembers: false };
  }
  const raw: unknown = frontmatter[key];
  if (raw === null) {
    return { key, shape: 'empty', complete: true, entries: [], slots: [], hasNonStringMembers: false };
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      return { key, shape: 'empty', complete: true, entries: [], slots: [], hasNonStringMembers: false };
    }
    const isComma = raw.includes(',');
    const rawParts = isComma ? raw.split(',') : [raw];
    const entries: FrontmatterTagEntry[] = [];
    for (let index = 0; index < rawParts.length; index++) {
      const part = rawParts[index].trim();
      if (!part) continue;
      if (!isValidTagPath(part)) {
        return { key, shape: 'unsupported', complete: false, entries: [], slots: [], hasNonStringMembers: false };
      }
      const tag = tagWithHash(part);
      entries.push({ key, raw: part, tag, id: tagIdentity(tag), hasHash: part.startsWith('#'), index });
    }
    if (!entries.length) {
      return { key, shape: 'empty', complete: true, entries: [], slots: [], hasNonStringMembers: false };
    }
    return {
      key,
      shape: isComma ? 'comma-string' : 'single-string',
      complete: true,
      entries,
      slots: entries.map(entry => ({ kind: 'tag', entry })),
      hasNonStringMembers: false,
    };
  }
  if (isUnknownArray(raw)) {
    if (!raw.length) {
      return { key, shape: 'empty', complete: true, entries: [], slots: [], hasNonStringMembers: false };
    }
    const entries: FrontmatterTagEntry[] = [];
    const slots: ArraySlot[] = [];
    let hasNonStringMembers = false;
    for (let index = 0; index < raw.length; index++) {
      const member: unknown = raw[index];
      if (typeof member !== 'string') {
        hasNonStringMembers = true;
        slots.push({ kind: 'non-string', raw: member });
        continue;
      }
      const trimmed = member.trim();
      if (!trimmed) {
        slots.push({ kind: 'empty-string', raw: member });
        continue;
      }
      if (!isValidTagPath(trimmed)) {
        return { key, shape: 'unsupported', complete: false, entries: [], slots: [], hasNonStringMembers };
      }
      const tag = tagWithHash(trimmed);
      const entry: FrontmatterTagEntry = {
        key,
        raw: member,
        tag,
        id: tagIdentity(tag),
        hasHash: trimmed.startsWith('#'),
        index,
      };
      entries.push(entry);
      slots.push({ kind: 'tag', entry });
    }
    return { key, shape: 'array', complete: true, entries, slots, hasNonStringMembers };
  }
  return { key, shape: 'unsupported', complete: false, entries: [], slots: [], hasNonStringMembers: false };
}

/**
 * Safely parse frontmatter `tags` and `tag` containers, preserving member order,
 * unknown non-string array members, and reporting container integrity explicitly.
 */
export function parseFrontmatterTags(frontmatter: Readonly<Record<string, unknown>>): ParsedTagContainers {
  const tags = parseContainer(frontmatter, 'tags');
  const tag = parseContainer(frontmatter, 'tag');
  const unsupportedKeys: TagContainerKey[] = [];
  if (!tags.complete) unsupportedKeys.push('tags');
  if (!tag.complete) unsupportedKeys.push('tag');
  return {
    tags,
    tag,
    complete: unsupportedKeys.length === 0,
    unsupportedKeys,
    entries: [...tags.entries, ...tag.entries],
  };
}

function dedupeRewrittenStrings(
  items: readonly { kind: 'string' | 'other'; value: unknown; id?: string }[],
  rewrittenTargetIds: ReadonlySet<string>,
): unknown[] {
  if (!rewrittenTargetIds.size) return items.map(item => item.value);
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const item of items) {
    if (item.kind === 'string' && item.id !== undefined && rewrittenTargetIds.has(item.id)) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
    }
    result.push(item.value);
  }
  return result;
}

/**
 * Rebuild frontmatter `tags` and `tag` containers in a single pass.
 * Unchanged containers are left completely untouched.
 * When all entries in a string container are removed, the value becomes `[]` while keeping the key.
 */
export function rewriteFrontmatterTags(
  afterFrontmatter: Record<string, unknown>,
  containers: ParsedTagContainers,
  transform: (entry: FrontmatterTagEntry) => FrontmatterTagAction,
): { changed: boolean; emptiedContainers: TagContainerKey[] } {
  let anyChanged = false;
  const emptiedContainers: TagContainerKey[] = [];

  for (const key of ['tags', 'tag'] as const) {
    const container = containers[key];
    if (!container.complete || container.shape === 'absent' || container.shape === 'empty') continue;

    let containerChanged = false;
    const rewrittenTargetIds = new Set<string>();

    if (container.shape === 'array') {
      const built: { kind: 'string' | 'other'; value: unknown; id?: string }[] = [];
      for (const slot of container.slots) {
        if (slot.kind === 'non-string') {
          built.push({ kind: 'other', value: slot.raw });
          continue;
        }
        if (slot.kind === 'empty-string') {
          built.push({ kind: 'other', value: slot.raw });
          continue;
        }
        const action = transform(slot.entry);
        if (action.kind === 'keep') {
          built.push({ kind: 'string', value: slot.entry.raw, id: slot.entry.id });
        } else if (action.kind === 'remove') {
          containerChanged = true;
        } else {
          const next = slot.entry.hasHash ? tagWithHash(action.to) : stripHash(action.to);
          const nextId = tagIdentity(action.to);
          if (next !== slot.entry.raw) containerChanged = true;
          rewrittenTargetIds.add(nextId);
          built.push({ kind: 'string', value: next, id: nextId });
        }
      }
      if (containerChanged) {
        const deduped = dedupeRewrittenStrings(built, rewrittenTargetIds);
        afterFrontmatter[key] = deduped;
        if (deduped.length === 0) emptiedContainers.push(key);
        anyChanged = true;
      }
    } else if (container.shape === 'single-string' || container.shape === 'comma-string') {
      const built: { kind: 'string'; value: string; id: string }[] = [];
      for (const entry of container.entries) {
        const action = transform(entry);
        if (action.kind === 'keep') {
          built.push({ kind: 'string', value: entry.raw, id: entry.id });
        } else if (action.kind === 'remove') {
          containerChanged = true;
        } else {
          const next = entry.hasHash ? tagWithHash(action.to) : stripHash(action.to);
          const nextId = tagIdentity(action.to);
          if (next !== entry.raw) containerChanged = true;
          rewrittenTargetIds.add(nextId);
          built.push({ kind: 'string', value: next, id: nextId });
        }
      }
      if (containerChanged) {
        const deduped = dedupeRewrittenStrings(built, rewrittenTargetIds) as string[];
        if (deduped.length === 0) {
          afterFrontmatter[key] = [];
          emptiedContainers.push(key);
        } else if (container.shape === 'single-string') {
          afterFrontmatter[key] = deduped[0];
        } else {
          afterFrontmatter[key] = deduped.join(', ');
        }
        anyChanged = true;
      }
    }
  }

  return { changed: anyChanged, emptiedContainers };
}
