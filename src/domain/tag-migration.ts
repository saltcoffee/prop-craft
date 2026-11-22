import type { FileChange, FileMeta, MigrateTagBranchOperation, TextOp, VaultSnapshot } from './models';
import type { IssueCode } from './errors';
import { OperationError } from './errors';
import type { CachedTag } from '../ports/VaultPort';
import type { DecodedNote } from '../ports/NoteCodecPort';
import { isTagInBranch, isValidTagPath, splitTagSegments, tagIdentity, tagWithHash, validateTagBranchPrefix, validateTagPath } from './normalize';
import { parseFrontmatterTags, rewriteFrontmatterTags, type ParsedTagContainers } from './frontmatter-tags';
import type { TagId } from './tag-tree';

export interface CompiledTagBranch {
  from: string;
  to: string;
  fromId: TagId;
  toId: TagId;
  fromSegments: readonly string[];
  toSegments: readonly string[];
  includeDescendants: boolean;
  sameIdentity: boolean;
}

export interface TagBranchTargetMapping {
  fromRaw: string;
  toRaw: string;
  targetId: TagId;
  overlap: boolean;
}

export interface TagBranchMapping {
  sourceId: TagId;
  sourceVariants: readonly string[];
  targets: readonly { fromRaw: string; toRaw: string; targetId: TagId }[];
  notePaths: readonly string[];
  targetPresentPaths: readonly string[];
  overlap: boolean;
}

export interface TagCollisionMatch {
  targetId: TagId;
  freshPaths: readonly string[];
  indexedOtherPaths: readonly string[];
}

export interface TagCollisionReport {
  snapshotRevision: number | null;
  generatedAt: number | null;
  freshCheckedPaths: readonly string[];
  indexedOnlyCheckedPaths: readonly string[];
  unknownPaths: readonly { path: string; reason: IssueCode }[];
  indexUnavailable: boolean;
  matches: readonly TagCollisionMatch[];
}

export interface TagBranchAnalysis {
  state: 'ready' | 'noop' | 'blocked';
  reason?: IssueCode;
  change?: FileChange;
  mappings: readonly (TagBranchTargetMapping & { sourceId: TagId })[];
  existingTagIds: readonly TagId[];
  overlap: boolean;
}

function compareLex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cloneFrontmatter(file: FileMeta): Record<string, unknown> {
  return Object.assign(Object.create(null) as Record<string, unknown>, structuredClone(file.rawFrontmatter));
}

export function compileTagBranch(operation: MigrateTagBranchOperation): CompiledTagBranch {
  const from = operation.includeDescendants ? validateTagBranchPrefix(operation.from) : validateTagPath(operation.from);
  const to = operation.includeDescendants ? validateTagBranchPrefix(operation.to) : validateTagPath(operation.to);
  const fromId = tagIdentity(from);
  const toId = tagIdentity(to);
  if (operation.includeDescendants && toId.startsWith(`${fromId}/`)) {
    throw new OperationError('tag-descendant-target');
  }
  return {
    from,
    to,
    fromId,
    toId,
    fromSegments: splitTagSegments(from),
    toSegments: splitTagSegments(to),
    includeDescendants: operation.includeDescendants,
    sameIdentity: fromId === toId,
  };
}

/**
 * Single-pass segment-based prefix replacement.
 * Extracts suffix segments from original-case path segments so Unicode case-folding
 * length differences can never slice the wrong characters.
 */
export function mapBranchTag(raw: string, compiled: CompiledTagBranch): TagBranchTargetMapping | null {
  if (!isTagInBranch(raw, compiled.from, compiled.includeDescendants)) return null;
  if (compiled.sameIdentity) return null;
  const normalizedFrom = tagWithHash(raw);
  const rawSegments = splitTagSegments(normalizedFrom);
  if (rawSegments.some(segment => segment.length === 0)) {
    throw new OperationError('tag-path-invalid');
  }
  const suffix = compiled.includeDescendants ? rawSegments.slice(compiled.fromSegments.length) : [];
  const candidate = `#${[...compiled.toSegments, ...suffix].join('/')}`;
  const toRaw = validateTagPath(candidate);
  const targetId = tagIdentity(toRaw);
  const overlap = isTagInBranch(toRaw, compiled.from, compiled.includeDescendants);
  return { fromRaw: normalizedFrom, toRaw, targetId, overlap };
}

export function collectFileTagIds(file: FileMeta, containers: ParsedTagContainers): Set<TagId> {
  const ids = new Set<TagId>();
  for (const entry of containers.entries) ids.add(entry.id);
  for (const occurrence of file.tags) {
    if (occurrence.positions.length > 0 && isValidTagPath(occurrence.tag)) {
      ids.add(tagIdentity(occurrence.tag));
    }
  }
  return ids;
}

export function analyzeTagBranch(
  file: FileMeta,
  compiled: CompiledTagBranch,
  containers: ParsedTagContainers,
): TagBranchAnalysis {
  if (file.frontmatterParseError) {
    return { state: 'blocked', reason: 'frontmatter-invalid', mappings: [], existingTagIds: [], overlap: false };
  }
  if (file.metadataStatus === 'unavailable') {
    return { state: 'blocked', reason: 'metadata-stale', mappings: [], existingTagIds: [], overlap: false };
  }
  if (!containers.complete) {
    return { state: 'blocked', reason: 'tag-container-unsupported', mappings: [], existingTagIds: [], overlap: false };
  }
  if (file.tagsComplete === false) {
    return { state: 'blocked', reason: 'metadata-stale', mappings: [], existingTagIds: [], overlap: false };
  }

  const existingIds = collectFileTagIds(file, containers);
  if (compiled.sameIdentity) {
    return { state: 'noop', reason: 'already-equal', mappings: [], existingTagIds: [...existingIds], overlap: false };
  }

  const mappingByPair = new Map<string, TagBranchTargetMapping & { sourceId: TagId }>();
  const registerMapping = (mapped: TagBranchTargetMapping): void => {
    const sourceId = tagIdentity(mapped.fromRaw);
    const key = `${mapped.fromRaw}\0${mapped.toRaw}`;
    if (!mappingByPair.has(key)) {
      mappingByPair.set(key, { ...mapped, sourceId });
    }
  };

  try {
    const beforeFrontmatter = cloneFrontmatter(file);
    const afterFrontmatter = cloneFrontmatter(file);

    const fmResult = rewriteFrontmatterTags(afterFrontmatter, containers, entry => {
      const mapped = mapBranchTag(entry.tag, compiled);
      if (!mapped) return { kind: 'keep' };
      registerMapping(mapped);
      return { kind: 'replace', to: mapped.toRaw };
    });

    const textOps: TextOp[] = [];
    for (const occurrence of file.tags) {
      if (!occurrence.positions.length) continue;
      const mapped = mapBranchTag(occurrence.tag, compiled);
      if (!mapped) continue;
      registerMapping(mapped);
      for (const position of occurrence.positions) {
        if (occurrence.tag !== mapped.toRaw) {
          textOps.push({
            start: position.start,
            end: position.end,
            expect: occurrence.tag,
            replacement: mapped.toRaw,
          });
        }
      }
    }

    textOps.sort((a, b) => a.start - b.start);
    const mappings = [...mappingByPair.values()];
    const overlap = mappings.some(item => item.overlap);

    if (!fmResult.changed && !textOps.length) {
      return {
        state: 'noop',
        reason: mappings.length ? 'already-equal' : 'source-missing',
        mappings,
        existingTagIds: [...existingIds],
        overlap,
      };
    }

    return {
      state: 'ready',
      change: { path: file.path, beforeFrontmatter, afterFrontmatter, textOps },
      mappings,
      existingTagIds: [...existingIds],
      overlap,
    };
  } catch (error) {
    const code = error instanceof OperationError ? error.code : 'tag-path-invalid';
    return { state: 'blocked', reason: code, mappings: [], existingTagIds: [...existingIds], overlap: false };
  }
}

/**
 * Aggregate formal branch mappings from freshly analyzed captures.
 */
export function buildBranchMappings(
  perFile: readonly {
    path: string;
    mappings: readonly (TagBranchTargetMapping & { sourceId: TagId })[];
    existingTagIds: readonly TagId[];
  }[],
): TagBranchMapping[] {
  const bySource = new Map<TagId, {
    variants: Set<string>;
    targets: Map<string, { fromRaw: string; toRaw: string; targetId: TagId }>;
    notePaths: Set<string>;
    targetIds: Set<TagId>;
    overlap: boolean;
  }>();

  for (const entry of perFile) {
    for (const mapping of entry.mappings) {
      let bucket = bySource.get(mapping.sourceId);
      if (!bucket) {
        bucket = { variants: new Set(), targets: new Map(), notePaths: new Set(), targetIds: new Set(), overlap: false };
        bySource.set(mapping.sourceId, bucket);
      }
      bucket.variants.add(mapping.fromRaw);
      bucket.targets.set(`${mapping.fromRaw}\0${mapping.toRaw}`, {
        fromRaw: mapping.fromRaw,
        toRaw: mapping.toRaw,
        targetId: mapping.targetId,
      });
      bucket.notePaths.add(entry.path);
      bucket.targetIds.add(mapping.targetId);
      if (mapping.overlap) bucket.overlap = true;
    }
  }

  const existingByTarget = new Map<TagId, Set<string>>();
  for (const entry of perFile) {
    for (const id of entry.existingTagIds) {
      let set = existingByTarget.get(id);
      if (!set) { set = new Set(); existingByTarget.set(id, set); }
      set.add(entry.path);
    }
  }

  return [...bySource.entries()]
    .sort(([a], [b]) => compareLex(a, b))
    .map(([sourceId, bucket]) => {
      const present = new Set<string>();
      for (const targetId of bucket.targetIds) {
        for (const path of existingByTarget.get(targetId) ?? []) present.add(path);
      }
      return {
        sourceId,
        sourceVariants: [...bucket.variants].sort(compareLex),
        targets: [...bucket.targets.values()].sort((a, b) => compareLex(a.fromRaw, b.fromRaw) || compareLex(a.toRaw, b.toRaw)),
        notePaths: [...bucket.notePaths].sort(compareLex),
        targetPresentPaths: [...present].sort(compareLex),
        overlap: bucket.overlap,
      };
    });
}

/**
 * Read-only target collision analysis combining freshly read files with the raw vault snapshot.
 * Includes out-of-scope, globally excluded, and manually excluded files as read-only index evidence
 * without expanding the writable capture set.
 */
export function analyzeTagCollisions(
  snapshot: VaultSnapshot | null,
  freshFiles: readonly FileMeta[],
  targetIds: ReadonlySet<TagId>,
  unknownPaths: readonly { path: string; reason: IssueCode }[],
  liveVaultPaths?: ReadonlySet<string>,
): TagCollisionReport {
  const freshByPath = new Map<string, FileMeta>();
  const freshMatches = new Map<TagId, Set<string>>();
  const indexedMatches = new Map<TagId, Set<string>>();
  const unknownMap = new Map<string, IssueCode>();

  for (const item of unknownPaths) {
    if (!unknownMap.has(item.path)) unknownMap.set(item.path, item.reason);
  }

  const freshCheckedPaths: string[] = [];
  for (const file of freshFiles) {
    const containers = parseFrontmatterTags(file.rawFrontmatter);
    if (file.frontmatterParseError || file.metadataStatus === 'unavailable' || file.tagsComplete === false || !containers.complete) {
      if (!unknownMap.has(file.path)) {
        unknownMap.set(
          file.path,
          file.frontmatterParseError ? 'frontmatter-invalid' : !containers.complete ? 'tag-container-unsupported' : 'metadata-stale',
        );
      }
      continue;
    }
    freshByPath.set(file.path, file);
    freshCheckedPaths.push(file.path);
    const ids = collectFileTagIds(file, containers);
    for (const targetId of targetIds) {
      if (ids.has(targetId)) {
        let set = freshMatches.get(targetId);
        if (!set) { set = new Set(); freshMatches.set(targetId, set); }
        set.add(file.path);
      }
    }
  }

  const indexedOnlyCheckedPaths: string[] = [];
  const indexUnavailable = snapshot === null;
  if (snapshot) {
    for (const [path, meta] of snapshot.files) {
      if (liveVaultPaths && !liveVaultPaths.has(path)) continue;
      if (freshByPath.has(path)) continue;
      if (unknownMap.has(path)) continue;
      const containers = parseFrontmatterTags(meta.rawFrontmatter);
      if (meta.frontmatterParseError || meta.metadataStatus === 'unavailable' || meta.tagsComplete === false || !containers.complete) {
        unknownMap.set(
          path,
          meta.frontmatterParseError ? 'frontmatter-invalid' : !containers.complete ? 'tag-container-unsupported' : 'metadata-stale',
        );
        continue;
      }
      indexedOnlyCheckedPaths.push(path);
      const ids = collectFileTagIds(meta, containers);
      for (const targetId of targetIds) {
        if (ids.has(targetId)) {
          let set = indexedMatches.get(targetId);
          if (!set) { set = new Set(); indexedMatches.set(targetId, set); }
          set.add(path);
        }
      }
    }
  }

  const matches: TagCollisionMatch[] = [];
  for (const targetId of [...targetIds].sort(compareLex)) {
    const freshPaths = [...(freshMatches.get(targetId) ?? [])].sort(compareLex);
    const indexedOtherPaths = [...(indexedMatches.get(targetId) ?? [])].sort(compareLex);
    if (freshPaths.length || indexedOtherPaths.length) {
      matches.push({ targetId, freshPaths, indexedOtherPaths });
    }
  }

  return {
    snapshotRevision: snapshot ? snapshot.revision : null,
    generatedAt: snapshot ? snapshot.generatedAt : null,
    freshCheckedPaths: freshCheckedPaths.sort(compareLex),
    indexedOnlyCheckedPaths: indexedOnlyCheckedPaths.sort(compareLex),
    unknownPaths: [...unknownMap.entries()]
      .sort(([a], [b]) => compareLex(a, b))
      .map(([path, reason]) => ({ path, reason })),
    indexUnavailable,
    matches,
  };
}

export interface TagSemanticVerificationInput {
  beforeDecoded: DecodedNote;
  beforeBodyTags: readonly CachedTag[];
  textOps: readonly TextOp[];
  afterDecoded: DecodedNote;
  afterBodyTags: readonly CachedTag[];
}

export type TagSemanticVerificationResult =
  | { ok: true }
  | { ok: false; code: 'tag-semantics-changed'; detail: string };

/**
 * Re-parse verification: compares every actual body tag token in the encoded candidate
 * against the exact expected token list derived from the original tokens, header shift,
 * and planned textOps. Rejects any newly activated, missing, truncated, merged, or shifted token.
 */
export function verifyRewrittenTagSemantics(input: TagSemanticVerificationInput): TagSemanticVerificationResult {
  const { beforeDecoded, beforeBodyTags, textOps, afterDecoded, afterBodyTags } = input;
  const sortedOps = [...textOps].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sortedOps.length; i++) {
    const op = sortedOps[i];
    if (op.start < beforeDecoded.bodyStart || op.end <= op.start) {
      return { ok: false, code: 'tag-semantics-changed', detail: 'op-out-of-body' };
    }
    if (i > 0 && sortedOps[i - 1].end > op.start) {
      return { ok: false, code: 'tag-semantics-changed', detail: 'op-overlap' };
    }
  }

  const headerShift = afterDecoded.bodyStart - beforeDecoded.bodyStart;
  const sortedBefore = [...beforeBodyTags].sort((a, b) => a.start - b.start);
  const expected: { tag: string; id: TagId; start: number; end: number }[] = [];

  for (const orig of sortedBefore) {
    let deltaBefore = 0;
    let matchedOp: TextOp | undefined;
    for (const op of sortedOps) {
      if (op.end <= orig.start) {
        deltaBefore += op.replacement.length - (op.end - op.start);
      } else if (op.start === orig.start && op.end === orig.end) {
        matchedOp = op;
      } else if (op.start < orig.end && op.end > orig.start) {
        return { ok: false, code: 'tag-semantics-changed', detail: `partial-overlap:${orig.tag}` };
      }
    }
    if (matchedOp) {
      if (matchedOp.replacement === '') continue; // Planned removal.
      const start = orig.start + headerShift + deltaBefore;
      const end = start + matchedOp.replacement.length;
      expected.push({ tag: matchedOp.replacement, id: tagIdentity(matchedOp.replacement), start, end });
    } else {
      const start = orig.start + headerShift + deltaBefore;
      const end = orig.end + headerShift + deltaBefore;
      expected.push({ tag: orig.tag, id: tagIdentity(orig.tag), start, end });
    }
  }

  const actual = [...afterBodyTags].sort((a, b) => a.start - b.start);
  if (actual.length !== expected.length) {
    return {
      ok: false,
      code: 'tag-semantics-changed',
      detail: `count:${expected.length}->${actual.length}`,
    };
  }

  for (let i = 0; i < expected.length; i++) {
    const exp = expected[i];
    const act = actual[i];
    if (
      act.tag !== exp.tag
      || tagIdentity(act.tag) !== exp.id
      || act.start !== exp.start
      || act.end !== exp.end
    ) {
      return {
        ok: false,
        code: 'tag-semantics-changed',
        detail: `token:${exp.tag}@${exp.start}-${exp.end}!=${act.tag}@${act.start}-${act.end}`,
      };
    }
  }

  const afterContainers = parseFrontmatterTags(afterDecoded.frontmatter);
  if (!afterContainers.complete) {
    return { ok: false, code: 'tag-semantics-changed', detail: 'frontmatter-container-invalid' };
  }

  return { ok: true };
}
