import type { ChangeOperation, FileMeta, VaultSnapshot } from '../domain/models';
import type { PreviewDecision, PreviewItem, TagBranchSummary, TagMigrationAnalysis, TagMigrationCandidateView, ValueConfirmation } from '../domain/preview';
import type { IssueCode } from '../domain/errors';
import type { CachedTag, VaultPort } from '../ports/VaultPort';
import type { DecodedNote, NoteCodecPort } from '../ports/NoteCodecPort';
import { diffForFile } from '../domain/diff';
import { isTypeCompatible } from '../domain/type-config';
import type { DeclarationInfo } from '../domain/value-distribution';
import { parseFrontmatterTags } from '../domain/frontmatter-tags';
import {
  analyzeTagBranch,
  analyzeTagCollisions,
  buildBranchMappings,
  verifyRewrittenTagSemantics,
  type CompiledTagBranch,
  type TagBranchTargetMapping,
} from '../domain/tag-migration';
import {
  analyzeTagProperty,
  isRuleRepresented,
  type CompiledTagProperty,
  type TagPropertyResolution,
} from '../domain/tag-property';
import type { TagId } from '../domain/tag-tree';

export interface EvaluatedCaptureInput {
  path: string;
  beforeContent: string;
  beforeHash: string;
  file?: FileMeta;
  decoded?: DecodedNote;
  bodyTags: readonly CachedTag[];
  issue?: IssueCode;
}

export interface BranchEvaluationOutput {
  item: PreviewItem;
  afterContent?: string;
  mappingRecord?: {
    path: string;
    mappings: readonly (TagBranchTargetMapping & { sourceId: TagId })[];
    existingTagIds: readonly TagId[];
  };
  overlap: boolean;
}

export async function evaluateBranchCapture(
  capture: EvaluatedCaptureInput,
  decision: PreviewDecision,
  compiled: CompiledTagBranch,
  codec: NoteCodecPort,
  vault: VaultPort,
  stale: boolean,
  signal?: AbortSignal,
): Promise<BranchEvaluationOutput> {
  signal?.throwIfAborted();
  const item: PreviewItem = {
    path: capture.path,
    state: 'blocked',
    disposition: 'blocked',
    decision: { ...decision },
    conflict: false,
    allowedStrategies: [],
    diffs: [],
    reason: capture.issue,
  };
  if (!capture.file || !capture.decoded || capture.issue) {
    if (stale) { item.stale = true; item.disposition = 'skip'; item.reason = 'file-stale'; }
    return { item, overlap: false };
  }

  const containers = parseFrontmatterTags(capture.file.rawFrontmatter);
  const analyzed = analyzeTagBranch(capture.file, compiled, containers);
  const mappingRecord = {
    path: capture.path,
    mappings: analyzed.mappings,
    existingTagIds: stale ? [] : analyzed.existingTagIds,
  };
  item.state = analyzed.state;
  item.reason = analyzed.reason;
  item.disposition = analyzed.state === 'ready' ? 'execute' : analyzed.state === 'noop' ? 'noop' : 'blocked';

  let afterContent: string | undefined;
  if (analyzed.state === 'ready' && analyzed.change) {
    const encoded = codec.compose(capture.beforeContent, capture.decoded, analyzed.change);
    if (!encoded.ok) {
      item.state = 'blocked';
      item.disposition = 'blocked';
      item.reason = encoded.code;
    } else {
      const afterDecoded = codec.decode(encoded.content);
      signal?.throwIfAborted();
      const afterTags = afterDecoded.ok ? await vault.readBoundTags(capture.path, encoded.content, signal) : null;
      signal?.throwIfAborted();
      const sem = afterDecoded.ok && afterTags?.ok
        ? verifyRewrittenTagSemantics({
          beforeDecoded: capture.decoded,
          beforeBodyTags: capture.bodyTags,
          textOps: analyzed.change.textOps,
          afterDecoded: afterDecoded.note,
          afterBodyTags: afterTags.bodyTags,
        })
        : { ok: false as const, code: 'tag-semantics-changed' as const, detail: 'reparse-failed' };
      if (!sem.ok) {
        item.state = 'blocked';
        item.disposition = 'blocked';
        item.reason = 'tag-semantics-changed';
      } else {
        item.diffs = diffForFile(analyzed.change, capture.beforeContent);
        if (encoded.content === capture.beforeContent) {
          item.state = 'noop';
          item.disposition = 'noop';
          item.reason = 'no-change';
        } else {
          afterContent = encoded.content;
        }
      }
    }
  }

  if (item.disposition === 'execute' && !decision.selected) {
    item.disposition = 'skip';
    item.reason = 'user-unselected';
  }
  if (stale) {
    item.stale = true;
    item.disposition = 'skip';
    item.reason = 'file-stale';
  }
  return { item, afterContent, mappingRecord, overlap: analyzed.overlap };
}

export function buildTagBranchSummary(
  snapshot: VaultSnapshot | null,
  vault: VaultPort,
  captures: readonly EvaluatedCaptureInput[],
  mappingRecords: readonly {
    path: string;
    mappings: readonly (TagBranchTargetMapping & { sourceId: TagId })[];
    existingTagIds: readonly TagId[];
  }[],
  overlap: boolean,
  stalePaths: ReadonlySet<string> = new Set(),
): TagBranchSummary {
  const mappings = buildBranchMappings(mappingRecords);
  const targetIds = new Set<TagId>();
  for (const mapping of mappings) {
    for (const target of mapping.targets) targetIds.add(target.targetId);
  }

  const freshFiles: FileMeta[] = [];
  const handledSet = new Set<string>();
  const unknownPaths: { path: string; reason: IssueCode }[] = [];

  for (const capture of captures) {
    if (stalePaths.has(capture.path)) {
      unknownPaths.push({ path: capture.path, reason: 'file-stale' });
      handledSet.add(capture.path);
    } else if (capture.file && !capture.issue) {
      freshFiles.push(capture.file);
      handledSet.add(capture.path);
    } else if (capture.issue) {
      unknownPaths.push({ path: capture.path, reason: capture.issue });
      handledSet.add(capture.path);
    }
  }

  // Account for live vault files added or modified since the last snapshot without reading their contents.
  const liveVaultPaths = new Set<string>();
  for (const entry of vault.getMarkdownFiles()) {
    liveVaultPaths.add(entry.path);
    if (handledSet.has(entry.path)) continue;
    if (!snapshot) {
      unknownPaths.push({ path: entry.path, reason: 'metadata-stale' });
      continue;
    }
    const indexed = snapshot.files.get(entry.path);
    if (!indexed || indexed.mtime !== vault.getMtime(entry.path)) {
      unknownPaths.push({ path: entry.path, reason: 'metadata-stale' });
    }
  }

  const collisions = analyzeTagCollisions(snapshot, freshFiles, targetIds, unknownPaths, liveVaultPaths);
  return { mappings, collisions, overlap };
}

interface VerifiedTagPropertyCandidate extends TagMigrationCandidateView {
  afterContent?: string;
}

export async function evaluateTagPropertyCapture(
  capture: EvaluatedCaptureInput,
  decision: PreviewDecision,
  compiled: CompiledTagProperty,
  declaration: DeclarationInfo | undefined,
  codec: NoteCodecPort,
  vault: VaultPort,
  stale: boolean,
  signal?: AbortSignal,
): Promise<{ item: PreviewItem; afterContent?: string }> {
  signal?.throwIfAborted();
  const item: PreviewItem = {
    path: capture.path,
    state: 'blocked',
    disposition: 'blocked',
    decision: { ...decision },
    conflict: false,
    allowedStrategies: [],
    diffs: [],
    reason: capture.issue,
  };
  if (!capture.file || !capture.decoded || capture.issue) {
    if (stale) { item.stale = true; item.disposition = 'skip'; item.reason = 'file-stale'; }
    return { item };
  }

  const containers = parseFrontmatterTags(capture.file.rawFrontmatter);
  const draft = analyzeTagProperty(capture.file, compiled, containers);

  const baseTagAnalysis: TagMigrationAnalysis = {
    matchedRuleIds: draft.matchedSources.map(source => source.ruleId),
    matchedSources: draft.matchedSources,
    hasExisting: draft.hasExisting,
    existingValue: draft.existingValue,
    existingType: draft.existingType,
    requiresResolution: draft.requiresResolution,
    allowedResolutions: [],
    candidates: [],
    issues: draft.issues,
  };

  if (draft.baseState === 'noop') {
    item.state = 'noop';
    item.disposition = 'noop';
    item.reason = draft.reason;
    item.tagAnalysis = baseTagAnalysis;
    if (stale) { item.stale = true; item.disposition = 'skip'; item.reason = 'file-stale'; }
    return { item };
  }

  if (declaration?.kind === 'unavailable') {
    item.state = 'blocked';
    item.disposition = 'blocked';
    item.reason = 'type-config-unsupported';
    item.tagAnalysis = { ...baseTagAnalysis, issues: [{ code: 'type-config-unsupported' }] };
    if (stale) { item.stale = true; item.disposition = 'skip'; item.reason = 'file-stale'; }
    return { item };
  }

  if (draft.baseState === 'blocked') {
    item.state = 'blocked';
    item.disposition = 'blocked';
    item.reason = draft.reason;
    item.tagAnalysis = baseTagAnalysis;
    if (stale) { item.stale = true; item.disposition = 'skip'; item.reason = 'file-stale'; }
    return { item };
  }

  // Verify every candidate via compose + decode + re-parse bound tags before granting selectability.
  const verified: VerifiedTagPropertyCandidate[] = [];
  for (const cand of draft.candidates) {
    signal?.throwIfAborted();
    const encoded = codec.compose(capture.beforeContent, capture.decoded, cand.change);
    let selectable = false;
    let blockedReason: IssueCode | undefined;
    let blockedDetail: string | undefined;
    let diffs = [] as PreviewItem['diffs'];
    let afterContent: string | undefined;
    const requiredConfirmations: ValueConfirmation[] = [];

    if (!encoded.ok) {
      blockedReason = encoded.code;
    } else {
      const afterDecoded = codec.decode(encoded.content);
      signal?.throwIfAborted();
      const afterTags = afterDecoded.ok ? await vault.readBoundTags(capture.path, encoded.content, signal) : null;
      signal?.throwIfAborted();
      const sem = afterDecoded.ok && afterTags?.ok
        ? verifyRewrittenTagSemantics({
          beforeDecoded: capture.decoded,
          beforeBodyTags: capture.bodyTags,
          textOps: cand.change.textOps,
          afterDecoded: afterDecoded.note,
          afterBodyTags: afterTags.bodyTags,
        })
        : { ok: false as const, code: 'tag-semantics-changed' as const, detail: 'reparse-failed' };

      const representedOk = afterDecoded.ok && cand.removableRuleIds.every(ruleId => {
        const rule = compiled.byRuleId.get(ruleId);
        return Boolean(rule && isRuleRepresented(rule, afterDecoded.note.frontmatter[compiled.key], compiled.mode));
      });

      if (!sem.ok || !representedOk) {
        blockedReason = 'tag-semantics-changed';
        blockedDetail = !sem.ok ? sem.detail : 'representation-mismatch';
      } else {
        selectable = true;
        afterContent = encoded.content;
        diffs = diffForFile(cand.change, capture.beforeContent);
        if (cand.propertyChanged && declaration?.kind === 'known' && !isTypeCompatible(declaration.type, cand.value)) {
          requiredConfirmations.push('declared-type-mismatch');
        }
      }
    }

    verified.push({
      id: cand.id,
      resolution: cand.resolution,
      ruleIds: cand.ruleIds,
      value: cand.value,
      afterType: cand.afterType,
      propertyChanged: cand.propertyChanged,
      representedRuleIds: cand.representedRuleIds,
      removableRuleIds: cand.removableRuleIds,
      retainedRuleIds: cand.retainedRuleIds,
      dispositions: cand.dispositions,
      requiredConfirmations,
      diffs,
      selectable,
      blockedReason,
      blockedDetail,
      afterContent,
    });
  }

  const selectableCandidates = verified.filter(cand => cand.selectable);
  const selectableRuleIds = new Set(selectableCandidates.flatMap(cand => cand.ruleIds));
  const hasSelectableReplaceList = selectableCandidates.some(cand => cand.resolution.kind === 'replace-list');

  const allowedResolutions: TagPropertyResolution[] = draft.requiresResolution && selectableCandidates.length > 0
    ? draft.allowedResolutions.filter(res => {
      if (res.kind === 'use-mapped') return selectableRuleIds.has(res.ruleId);
      if (res.kind === 'replace-list') return hasSelectableReplaceList;
      return true;
    })
    : [];

  const candidateViews: TagMigrationCandidateView[] = verified.map(cand => ({
    id: cand.id,
    resolution: cand.resolution,
    ruleIds: cand.ruleIds,
    value: cand.value,
    afterType: cand.afterType,
    propertyChanged: cand.propertyChanged,
    representedRuleIds: cand.representedRuleIds,
    removableRuleIds: cand.removableRuleIds,
    retainedRuleIds: cand.retainedRuleIds,
    dispositions: cand.dispositions,
    requiredConfirmations: cand.requiredConfirmations,
    diffs: cand.diffs,
    selectable: cand.selectable,
    blockedReason: cand.blockedReason,
    blockedDetail: cand.blockedDetail,
  }));

  const issues = [...draft.issues, ...verified.filter(c => !c.selectable && c.blockedReason).map(c => ({
    code: c.blockedReason!,
    ruleIds: c.ruleIds.length ? c.ruleIds : undefined,
    detail: c.blockedDetail,
  }))];

  const finishCandidate = (chosen: VerifiedTagPropertyCandidate | undefined): { item: PreviewItem; afterContent?: string } => {
    if (!chosen || !chosen.selectable || chosen.afterContent === undefined) {
      const failed = chosen ?? verified[0];
      item.state = 'blocked';
      item.disposition = 'blocked';
      item.reason = failed?.blockedReason ?? 'tag-semantics-changed';
      item.tagAnalysis = { ...baseTagAnalysis, allowedResolutions, candidates: candidateViews, issues };
      if (stale) { item.stale = true; item.disposition = 'skip'; item.reason = 'file-stale'; }
      return { item };
    }

    item.diffs = [...chosen.diffs];
    item.tagAnalysis = {
      ...baseTagAnalysis,
      allowedResolutions,
      candidates: candidateViews,
      selectedCandidateId: chosen.id,
      issues,
    };
    const unmet = chosen.requiredConfirmations.filter(conf =>
      conf === 'declared-type-mismatch' ? !decision.declaredTypeMismatchConfirmed : false,
    );
    const confirmationIssue = (conf: ValueConfirmation): IssueCode =>
      conf === 'declared-type-mismatch' ? 'declared-type-mismatch' : conf === 'date-interpretation' ? 'date-ambiguous' : 'date-value-loss';
    item.valueAnalysis = {
      outcome: chosen.requiredConfirmations.length ? 'needs-confirmation' : 'ready',
      beforeType: draft.existingType,
      afterType: chosen.afterType,
      candidate: chosen.value,
      ruleIds: chosen.representedRuleIds,
      issues: chosen.requiredConfirmations.map(conf => ({ code: confirmationIssue(conf) })),
      requiredConfirmations: chosen.requiredConfirmations,
    };

    if (unmet.length > 0) {
      item.state = 'conflict';
      item.conflict = true;
      item.disposition = 'skip';
      item.reason = confirmationIssue(unmet[0]);
      if (stale) { item.stale = true; item.disposition = 'skip'; item.reason = 'file-stale'; }
      return { item };
    }

    if (chosen.afterContent === capture.beforeContent) {
      item.state = 'noop';
      item.disposition = 'noop';
      item.reason = 'no-change';
      if (stale) { item.stale = true; item.disposition = 'skip'; item.reason = 'file-stale'; }
      return { item };
    }

    item.state = 'ready';
    item.disposition = decision.selected ? 'execute' : 'skip';
    item.reason = decision.selected ? undefined : 'user-unselected';
    if (stale) { item.stale = true; item.disposition = 'skip'; item.reason = 'file-stale'; }
    return { item, afterContent: chosen.afterContent };
  };

  if (!draft.requiresResolution) {
    return finishCandidate(verified[0]);
  }

  if (selectableCandidates.length === 0) {
    const failed = verified[0];
    item.state = 'blocked';
    item.disposition = 'blocked';
    item.reason = failed?.blockedReason ?? 'tag-semantics-changed';
    item.tagAnalysis = { ...baseTagAnalysis, allowedResolutions: [], candidates: candidateViews, issues };
    if (stale) { item.stale = true; item.disposition = 'skip'; item.reason = 'file-stale'; }
    return { item };
  }

  const res = decision.tagPropertyResolution;
  if (!res) {
    item.state = 'conflict';
    item.conflict = true;
    item.disposition = 'skip';
    item.reason = draft.reason;
    item.tagAnalysis = { ...baseTagAnalysis, allowedResolutions, candidates: candidateViews, issues };
    if (stale) { item.stale = true; item.disposition = 'skip'; item.reason = 'file-stale'; }
    return { item };
  }

  if (res.kind === 'keep-existing' || res.kind === 'skip') {
    item.state = 'conflict';
    item.conflict = true;
    item.disposition = 'skip';
    item.reason = 'policy-skip';
    item.tagAnalysis = { ...baseTagAnalysis, allowedResolutions, candidates: candidateViews, issues };
    if (stale) { item.stale = true; item.disposition = 'skip'; item.reason = 'file-stale'; }
    return { item };
  }

  const chosen = verified.find(cand =>
    res.kind === 'replace-list' ? cand.resolution.kind === 'replace-list' : cand.ruleIds.includes(res.ruleId),
  );
  return finishCandidate(chosen);
}

export function isTagOperation(operation: ChangeOperation): boolean {
  return operation.kind === 'renameTag'
    || operation.kind === 'mergeTag'
    || operation.kind === 'migrateTagBranch'
    || operation.kind === 'convertTagsToProperty';
}
