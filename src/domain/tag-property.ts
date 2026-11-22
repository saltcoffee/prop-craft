import type { ConvertTagsToPropertyOperation, FileChange, FileMeta, TagPropertyRule, TextOp, ValueScalar } from './models';
import type { IssueCode } from './errors';
import { OperationError } from './errors';
import { RESERVED_KEYS } from '../constants';
import { hasOwn } from './scope';
import { tagIdentity, validateTagPath } from './normalize';
import { actualValueType, isSafeNumericTarget, isValueScalar, scalarFromRaw, scalarIdentity, scalarToRaw, valueIdentity, type ActualValueType } from './property-value';
import { rewriteFrontmatterTags, type ParsedTagContainers } from './frontmatter-tags';
import type { TagId } from './tag-tree';

export type TagPropertyResolution =
  | { kind: 'use-mapped'; ruleId: string }
  | { kind: 'replace-list' }
  | { kind: 'keep-existing' }
  | { kind: 'skip' };

export interface CompiledTagRule {
  id: string;
  tag: string;
  tagId: TagId;
  value: ValueScalar;
  valueId: string;
  order: number;
}

export interface CompiledTagProperty {
  key: string;
  mode: 'scalar' | 'list';
  removeSourceTags: boolean;
  rules: readonly CompiledTagRule[];
  byTagId: ReadonlyMap<TagId, CompiledTagRule>;
  byRuleId: ReadonlyMap<string, CompiledTagRule>;
}

export interface MatchedTagSource {
  ruleId: string;
  tag: string;
  tagId: TagId;
  value: ValueScalar;
  variants: readonly string[];
  origins: readonly ('tags' | 'tag' | 'body')[];
  bodyCount: number;
}

export interface TagSourceDisposition {
  ruleId: string;
  tag: string;
  action: 'remove' | 'keep';
  reason: 'represented' | 'tag-source-retained' | 'tag-source-unrepresented';
}

export interface TagPropertyCandidateDraft {
  id: string;
  resolution: TagPropertyResolution;
  /** Rule ids that accept `use-mapped` for this candidate (empty for `replace-list`). */
  ruleIds: readonly string[];
  value: unknown;
  afterType: ActualValueType;
  propertyChanged: boolean;
  representedRuleIds: readonly string[];
  removableRuleIds: readonly string[];
  retainedRuleIds: readonly string[];
  dispositions: readonly TagSourceDisposition[];
  change: FileChange;
}

export interface TagPropertyAnalysisDraft {
  baseState: 'ready' | 'conflict' | 'noop' | 'blocked';
  reason?: IssueCode;
  requiresResolution: boolean;
  hasExisting: boolean;
  existingValue?: unknown;
  existingType?: ActualValueType;
  matchedSources: readonly MatchedTagSource[];
  candidates: readonly TagPropertyCandidateDraft[];
  allowedResolutions: readonly TagPropertyResolution[];
  issues: readonly { code: IssueCode; ruleIds?: readonly string[] }[];
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isSupportedScalarList(raw: unknown): raw is readonly (string | number | boolean)[] {
  return isUnknownArray(raw) && raw.every(item => scalarFromRaw(item) !== null);
}

function cloneFrontmatter(file: FileMeta): Record<string, unknown> {
  return Object.assign(Object.create(null) as Record<string, unknown>, structuredClone(file.rawFrontmatter));
}

export function isRuleRepresented(rule: CompiledTagRule, finalValue: unknown, mode: 'scalar' | 'list'): boolean {
  if (mode === 'scalar') {
    return valueIdentity(finalValue) === rule.valueId;
  }
  if (!isUnknownArray(finalValue)) return false;
  return finalValue.some(item => valueIdentity(item) === rule.valueId);
}

export function sameTagResolution(a: TagPropertyResolution | undefined, b: TagPropertyResolution | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'use-mapped' && b.kind === 'use-mapped') return a.ruleId === b.ruleId;
  return true;
}

export function isValidTagPropertyResolution(value: unknown): value is TagPropertyResolution {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === 'use-mapped') return typeof candidate.ruleId === 'string' && candidate.ruleId.length > 0;
  return candidate.kind === 'replace-list' || candidate.kind === 'keep-existing' || candidate.kind === 'skip';
}

export function compileTagProperty(operation: ConvertTagsToPropertyOperation): CompiledTagProperty {
  if (typeof operation.key !== 'string' || !operation.key.trim()) {
    throw new OperationError('input-invalid');
  }
  if (RESERVED_KEYS.has(operation.key.toLowerCase())) {
    throw new OperationError('reserved-key');
  }
  if (operation.mode !== 'scalar' && operation.mode !== 'list') {
    throw new OperationError('input-invalid');
  }
  if (typeof operation.removeSourceTags !== 'boolean') {
    throw new OperationError('input-invalid');
  }
  const rawRules: unknown = operation.rules;
  if (!isUnknownArray(rawRules) || rawRules.length === 0) {
    throw new OperationError('input-invalid');
  }

  const rules: CompiledTagRule[] = [];
  const byTagId = new Map<TagId, CompiledTagRule>();
  const byRuleId = new Map<string, CompiledTagRule>();

  for (let order = 0; order < rawRules.length; order++) {
    const entry: unknown = rawRules[order];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new OperationError('input-invalid');
    }
    const rawRule = entry as Partial<TagPropertyRule>;
    if (typeof rawRule.id !== 'string' || !rawRule.id) {
      throw new OperationError('input-invalid');
    }
    if (byRuleId.has(rawRule.id)) {
      throw new OperationError('tag-rule-duplicate');
    }
    if (typeof rawRule.tag !== 'string') {
      throw new OperationError('tag-path-invalid');
    }
    const normalizedTag = validateTagPath(rawRule.tag);
    const tagId = tagIdentity(normalizedTag);
    if (byTagId.has(tagId)) {
      throw new OperationError('tag-rule-duplicate');
    }
    if (!isValueScalar(rawRule.value)) {
      throw new OperationError('input-invalid');
    }
    if (rawRule.value.type === 'number' && !isSafeNumericTarget(rawRule.value.value)) {
      throw new OperationError('number-precision');
    }
    const compiled: CompiledTagRule = {
      id: rawRule.id,
      tag: normalizedTag,
      tagId,
      value: structuredClone(rawRule.value),
      valueId: scalarIdentity(rawRule.value),
      order,
    };
    rules.push(compiled);
    byTagId.set(tagId, compiled);
    byRuleId.set(compiled.id, compiled);
  }

  return {
    key: operation.key,
    mode: operation.mode,
    removeSourceTags: operation.removeSourceTags,
    rules,
    byTagId,
    byRuleId,
  };
}

function buildCandidate(
  file: FileMeta,
  compiled: CompiledTagProperty,
  containers: ParsedTagContainers,
  matchedRules: readonly CompiledTagRule[],
  id: string,
  resolution: TagPropertyResolution,
  ruleIds: readonly string[],
  finalValue: unknown,
  propertyChanged: boolean,
): TagPropertyCandidateDraft {
  const representedRuleIds: string[] = [];
  const removableRuleIds: string[] = [];
  const retainedRuleIds: string[] = [];
  const dispositions: TagSourceDisposition[] = [];

  for (const rule of matchedRules) {
    const represented = isRuleRepresented(rule, finalValue, compiled.mode);
    if (represented) representedRuleIds.push(rule.id);
    if (compiled.removeSourceTags && represented) {
      removableRuleIds.push(rule.id);
      dispositions.push({ ruleId: rule.id, tag: rule.tag, action: 'remove', reason: 'represented' });
    } else {
      retainedRuleIds.push(rule.id);
      dispositions.push({
        ruleId: rule.id,
        tag: rule.tag,
        action: 'keep',
        reason: represented ? 'tag-source-retained' : 'tag-source-unrepresented',
      });
    }
  }

  const beforeFrontmatter = cloneFrontmatter(file);
  const afterFrontmatter = cloneFrontmatter(file);
  if (propertyChanged) {
    afterFrontmatter[compiled.key] = structuredClone(finalValue);
  }

  const removableTagIds = new Set(removableRuleIds.map(ruleId => compiled.byRuleId.get(ruleId)!.tagId));
  const textOps: TextOp[] = [];
  if (removableTagIds.size > 0) {
    rewriteFrontmatterTags(afterFrontmatter, containers, entry =>
      removableTagIds.has(entry.id) ? { kind: 'remove' } : { kind: 'keep' },
    );
    for (const occurrence of file.tags) {
      if (!occurrence.positions.length) continue;
      if (!removableTagIds.has(tagIdentity(occurrence.tag))) continue;
      for (const position of occurrence.positions) {
        textOps.push({
          start: position.start,
          end: position.end,
          expect: occurrence.tag,
          replacement: '',
        });
      }
    }
    textOps.sort((a, b) => a.start - b.start);
  }

  return {
    id,
    resolution,
    ruleIds,
    value: structuredClone(finalValue),
    afterType: actualValueType(finalValue),
    propertyChanged,
    representedRuleIds,
    removableRuleIds,
    retainedRuleIds,
    dispositions,
    change: { path: file.path, beforeFrontmatter, afterFrontmatter, textOps },
  };
}

/**
 * Pure per-file analysis for `convertTagsToProperty`.
 * Produces all lawful candidates and allowed resolutions without mutating the file
 * or assuming which candidate will pass encoding/semantic verification.
 */
export function analyzeTagProperty(
  file: FileMeta,
  compiled: CompiledTagProperty,
  containers: ParsedTagContainers,
): TagPropertyAnalysisDraft {
  const empty = (
    baseState: TagPropertyAnalysisDraft['baseState'],
    reason?: IssueCode,
    extra: Partial<TagPropertyAnalysisDraft> = {},
  ): TagPropertyAnalysisDraft => ({
    baseState,
    reason,
    requiresResolution: false,
    hasExisting: hasOwn(file.rawFrontmatter, compiled.key),
    existingValue: hasOwn(file.rawFrontmatter, compiled.key) ? structuredClone(file.rawFrontmatter[compiled.key]) : undefined,
    existingType: hasOwn(file.rawFrontmatter, compiled.key) ? actualValueType(file.rawFrontmatter[compiled.key]) : undefined,
    matchedSources: [],
    candidates: [],
    allowedResolutions: [],
    issues: reason ? [{ code: reason }] : [],
    ...extra,
  });

  if (file.frontmatterParseError) return empty('blocked', 'frontmatter-invalid');
  if (file.metadataStatus === 'unavailable') return empty('blocked', 'metadata-stale');
  if (!containers.complete) return empty('blocked', 'tag-container-unsupported');
  if (file.tagsComplete === false) return empty('blocked', 'metadata-stale');

  // Collect exact matched sources across frontmatter `tags`, `tag`, and body positions.
  const matchInfo = new Map<string, { variants: Set<string>; origins: Set<'tags' | 'tag' | 'body'>; bodyCount: number }>();
  const recordMatch = (rule: CompiledTagRule, rawTag: string, origin: 'tags' | 'tag' | 'body', bodyIncrement = 0) => {
    let entry = matchInfo.get(rule.id);
    if (!entry) {
      entry = { variants: new Set(), origins: new Set(), bodyCount: 0 };
      matchInfo.set(rule.id, entry);
    }
    entry.variants.add(rawTag);
    entry.origins.add(origin);
    entry.bodyCount += bodyIncrement;
  };

  for (const entry of containers.entries) {
    const rule = compiled.byTagId.get(entry.id);
    if (rule) recordMatch(rule, entry.tag, entry.key);
  }
  for (const occurrence of file.tags) {
    if (!occurrence.positions.length) continue;
    const rule = compiled.byTagId.get(tagIdentity(occurrence.tag));
    if (rule) recordMatch(rule, occurrence.tag, 'body', occurrence.positions.length);
  }

  const matchedRules = compiled.rules.filter(rule => matchInfo.has(rule.id));
  if (!matchedRules.length) {
    return empty('noop', 'source-missing');
  }

  const matchedSources: MatchedTagSource[] = matchedRules.map(rule => {
    const info = matchInfo.get(rule.id)!;
    return {
      ruleId: rule.id,
      tag: rule.tag,
      tagId: rule.tagId,
      value: rule.value,
      variants: [...info.variants].sort(),
      origins: (['tags', 'tag', 'body'] as const).filter(origin => info.origins.has(origin)),
      bodyCount: info.bodyCount,
    };
  });

  const hasExisting = hasOwn(file.rawFrontmatter, compiled.key);
  const existingRaw: unknown = hasExisting ? file.rawFrontmatter[compiled.key] : undefined;
  const existingType = hasExisting ? actualValueType(existingRaw) : undefined;
  const baseFields = { hasExisting, existingValue: hasExisting ? structuredClone(existingRaw) : undefined, existingType, matchedSources };

  if (compiled.mode === 'scalar') {
    // Reject complex objects or arrays containing non-scalar/nested/null entries.
    if (hasExisting && (existingType === 'object' || (isUnknownArray(existingRaw) && !isSupportedScalarList(existingRaw)))) {
      return empty('blocked', 'tag-target-unsupported', baseFields);
    }

    // Group matched rules by exact typed value identity.
    const groups: { valueId: string; value: ValueScalar; ruleIds: string[] }[] = [];
    const groupByValue = new Map<string, { valueId: string; value: ValueScalar; ruleIds: string[] }>();
    for (const rule of matchedRules) {
      let group = groupByValue.get(rule.valueId);
      if (!group) {
        group = { valueId: rule.valueId, value: rule.value, ruleIds: [] };
        groupByValue.set(rule.valueId, group);
        groups.push(group);
      }
      group.ruleIds.push(rule.id);
    }

    if (groups.length === 1) {
      const only = groups[0];
      const rawTarget = scalarToRaw(only.value);
      const alreadyMatches = hasExisting && valueIdentity(existingRaw) === only.valueId;
      if (!hasExisting || alreadyMatches) {
        const propertyChanged = !alreadyMatches;
        if (!propertyChanged && !compiled.removeSourceTags) {
          return empty('noop', 'already-equal', baseFields);
        }
        const candidate = buildCandidate(
          file, compiled, containers, matchedRules,
          `use:${only.ruleIds[0]}`,
          { kind: 'use-mapped', ruleId: only.ruleIds[0] },
          only.ruleIds,
          rawTarget,
          propertyChanged,
        );
        return {
          ...baseFields,
          baseState: 'ready',
          requiresResolution: false,
          candidates: [candidate],
          allowedResolutions: [],
          issues: [],
        };
      }
      // Target exists with a different value (including null, "", [], 0, false, or scalar list).
      const candidate = buildCandidate(
        file, compiled, containers, matchedRules,
        `use:${only.ruleIds[0]}`,
        { kind: 'use-mapped', ruleId: only.ruleIds[0] },
        only.ruleIds,
        rawTarget,
        true,
      );
      const allowedResolutions: TagPropertyResolution[] = [
        ...only.ruleIds.map((ruleId): TagPropertyResolution => ({ kind: 'use-mapped', ruleId })),
        { kind: 'keep-existing' },
        { kind: 'skip' },
      ];
      return {
        ...baseFields,
        baseState: 'conflict',
        reason: 'tag-target-conflict',
        requiresResolution: true,
        candidates: [candidate],
        allowedResolutions,
        issues: [{ code: 'tag-target-conflict', ruleIds: only.ruleIds }],
      };
    }

    // Multiple distinct scalar values matched: user must choose explicitly (never auto-pick first).
    const candidates = groups.map(group => {
      const rawTarget = scalarToRaw(group.value);
      const propertyChanged = !hasExisting || valueIdentity(existingRaw) !== group.valueId;
      return buildCandidate(
        file, compiled, containers, matchedRules,
        `use:${group.ruleIds[0]}`,
        { kind: 'use-mapped', ruleId: group.ruleIds[0] },
        group.ruleIds,
        rawTarget,
        propertyChanged,
      );
    });
    const allowedResolutions: TagPropertyResolution[] = [
      ...matchedRules.map((rule): TagPropertyResolution => ({ kind: 'use-mapped', ruleId: rule.id })),
      ...(hasExisting ? [{ kind: 'keep-existing' as const }] : []),
      { kind: 'skip' },
    ];
    return {
      ...baseFields,
      baseState: 'conflict',
      reason: 'tag-scalar-conflict',
      requiresResolution: true,
      candidates,
      allowedResolutions,
      issues: [{ code: 'tag-scalar-conflict', ruleIds: matchedRules.map(rule => rule.id) }],
    };
  }

  // List mode: append missing mapped values in rule display order with typed identity deduplication.
  const orderedValues: ValueScalar[] = [];
  const seenTargetIds = new Set<string>();
  for (const rule of matchedRules) {
    if (!seenTargetIds.has(rule.valueId)) {
      seenTargetIds.add(rule.valueId);
      orderedValues.push(rule.value);
    }
  }

  if (!hasExisting) {
    const finalList = orderedValues.map(scalarToRaw);
    const candidate = buildCandidate(
      file, compiled, containers, matchedRules,
      'list:append',
      { kind: 'replace-list' },
      [],
      finalList,
      true,
    );
    return {
      ...baseFields,
      baseState: 'ready',
      requiresResolution: false,
      candidates: [candidate],
      allowedResolutions: [],
      issues: [],
    };
  }

  if (isSupportedScalarList(existingRaw)) {
    const finalList: unknown[] = [...existingRaw];
    const existingIds = new Set(existingRaw.map(valueIdentity));
    for (const target of orderedValues) {
      const id = scalarIdentity(target);
      if (!existingIds.has(id)) {
        existingIds.add(id);
        finalList.push(scalarToRaw(target));
      }
    }
    const propertyChanged = finalList.length !== existingRaw.length;
    if (!propertyChanged && !compiled.removeSourceTags) {
      return empty('noop', 'already-equal', baseFields);
    }
    const candidate = buildCandidate(
      file, compiled, containers, matchedRules,
      'list:append',
      { kind: 'replace-list' },
      [],
      finalList,
      propertyChanged,
    );
    return {
      ...baseFields,
      baseState: 'ready',
      requiresResolution: false,
      candidates: [candidate],
      allowedResolutions: [],
      issues: [],
    };
  }

  if (existingRaw === null || scalarFromRaw(existingRaw) !== null) {
    const finalList = orderedValues.map(scalarToRaw);
    const candidate = buildCandidate(
      file, compiled, containers, matchedRules,
      'list:replace',
      { kind: 'replace-list' },
      [],
      finalList,
      true,
    );
    return {
      ...baseFields,
      baseState: 'conflict',
      reason: 'tag-target-conflict',
      requiresResolution: true,
      candidates: [candidate],
      allowedResolutions: [{ kind: 'replace-list' }, { kind: 'keep-existing' }, { kind: 'skip' }],
      issues: [{ code: 'tag-target-conflict', ruleIds: matchedRules.map(rule => rule.id) }],
    };
  }

  // Complex object or array containing null/object/nested array.
  return empty('blocked', 'tag-target-unsupported', baseFields);
}
