import type { FileMeta } from './models';
import { actualValueType, classifyField, valueIdentity, ACTUAL_TYPES, FIELD_STATES, type ActualValueType, type FieldState } from './property-value';

export interface ValueBucket {
  id: string;
  /** Read-only independent copy of the decoded raw value. */
  raw: unknown;
  actualType: ActualValueType;
  notePaths: readonly string[];
}
export type DeclarationInfo = { kind: 'known'; type: string } | { kind: 'absent' } | { kind: 'unavailable' };

export interface PropertyValueDistribution {
  requestId: number;
  snapshotRevision: number;
  scopeFingerprint: string;
  settingsFingerprint: string;
  key: string;
  mode: 'field' | 'member';
  declaration: DeclarationInfo;
  effectiveNoteCount: number;
  countedNoteCount: number;
  unreadablePaths: readonly string[];
  scopeUnknownPaths: readonly string[];
  states: Readonly<Record<FieldState, readonly string[]>>;
  actualTypePaths: Readonly<Record<ActualValueType, readonly string[]>>;
  buckets: readonly ValueBucket[];
  listNoteCount: number;
  nonListPresentNoteCount: number;
}

export interface DistributionInput {
  requestId: number;
  snapshotRevision: number;
  scopeFingerprint: string;
  settingsFingerprint: string;
  key: string;
  mode: 'field' | 'member';
  declaration: DeclarationInfo;
  /** Effective-scope metas, already decoded. Unreadable ones are partitioned out. */
  files: readonly FileMeta[];
  scopeUnknownPaths: readonly string[];
}

function emptyRecord<T extends string>(keys: readonly T[]): Record<T, string[]> {
  return Object.fromEntries(keys.map(key => [key, []])) as unknown as Record<T, string[]>;
}

/**
 * Aggregate one property into value buckets over a fixed snapshot.
 * Field mode counts complete raw values; member mode counts array members with per-note dedupe.
 */
export function buildDistribution(input: DistributionInput): PropertyValueDistribution {
  const states = emptyRecord(FIELD_STATES);
  const actualTypePaths = emptyRecord(ACTUAL_TYPES);
  const buckets = new Map<string, { raw: unknown; actualType: ActualValueType; paths: string[] }>();
  const unreadablePaths: string[] = [];
  let counted = 0;
  let listNoteCount = 0;
  let nonListPresentNoteCount = 0;
  const files = [...input.files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of files) {
    if (file.metadataStatus === 'unavailable' || file.frontmatterParseError) { unreadablePaths.push(file.path); continue; }
    counted++;
    const state = classifyField(file.rawFrontmatter, input.key);
    states[state].push(file.path);
    if (state === 'missing') continue;
    const raw = file.rawFrontmatter[input.key];
    const type = actualValueType(raw);
    actualTypePaths[type].push(file.path);
    if (type === 'list') listNoteCount++; else nonListPresentNoteCount++;
    const addBucket = (rawValue: unknown, bucketType: ActualValueType, path: string) => {
      const id = valueIdentity(rawValue);
      let bucket = buckets.get(id);
      if (!bucket) { bucket = { raw: structuredClone(rawValue), actualType: bucketType, paths: [] }; buckets.set(id, bucket); }
      bucket.paths.push(path);
    };
    if (input.mode === 'member') {
      if (!Array.isArray(raw)) continue;
      const seen = new Set<string>();
      for (const member of raw) {
        const id = valueIdentity(member);
        if (seen.has(id)) continue;
        seen.add(id);
        addBucket(member, actualValueType(member), file.path);
      }
    } else {
      addBucket(raw, type, file.path);
    }
  }
  const ordered = [...buckets.entries()].map(([id, bucket]) => ({ id, raw: bucket.raw, actualType: bucket.actualType, notePaths: bucket.paths }))
    .sort((a, b) => b.notePaths.length - a.notePaths.length || a.id.localeCompare(b.id));
  return {
    requestId: input.requestId,
    snapshotRevision: input.snapshotRevision,
    scopeFingerprint: input.scopeFingerprint,
    settingsFingerprint: input.settingsFingerprint,
    key: input.key,
    mode: input.mode,
    declaration: input.declaration,
    effectiveNoteCount: counted + unreadablePaths.length,
    countedNoteCount: counted,
    unreadablePaths,
    scopeUnknownPaths: [...input.scopeUnknownPaths],
    states,
    actualTypePaths,
    buckets: ordered,
    listNoteCount,
    nonListPresentNoteCount,
  };
}
