import type { ChangeOperation, FileMeta } from '../domain/models';
import type { AnalyzedOperation, PreparedChange, PreparedPlan, PreviewDecision, PreviewDecisionPatch, PreviewItem, PreviewView, TagBranchSummary, ValueSummary } from '../domain/preview';
import { summarizePreview } from '../domain/preview';
import { inBase, matchScope, validateScope, type ScopeQuery } from '../domain/scope';
import { validateOperation } from '../domain/operation';
import { analyzeOperation, type ValueAnalyzeContext } from '../domain/plan';
import { compileValueMapping, type CompiledValueMapping } from '../domain/value-mapping';
import { compileTagBranch, verifyRewrittenTagSemantics, type CompiledTagBranch, type TagBranchTargetMapping } from '../domain/tag-migration';
import { compileTagProperty, isValidTagPropertyResolution, sameTagResolution, type CompiledTagProperty } from '../domain/tag-property';
import type { DeclarationInfo } from '../domain/value-distribution';
import { diffForFile } from '../domain/diff';
import { OperationError, issueCode } from '../domain/errors';
import { isTypeCompatible } from '../domain/type-config';
import { tagWithHash, validateTagBranchPrefix, validateTagPath } from '../domain/normalize';
import type { NoteCodecPort, DecodedNote } from '../ports/NoteCodecPort';
import type { CachedTag, VaultPort } from '../ports/VaultPort';
import type { PropCraftSettings } from '../settings-model';
import { sha256Hex } from '../infrastructure/hash';
import type { SnapshotStore } from './SnapshotStore';
import { exclusionFingerprint, shouldExclude } from './exclude';
import { fileMeta } from './file-meta';
import type { TypeMigration } from './TypeMigration';
import { buildTagBranchSummary, evaluateBranchCapture, evaluateTagPropertyCapture, isTagOperation } from './tag-plan-evaluator';

export interface PreviewRequest { scope: ScopeQuery; operation: ChangeOperation }
export type PropertyWritePolicy = 'strict-declaration' | 'confirm-data-only';
/** Declared-type mismatch is confirmable for 0.1.3 value operations and 0.1.4 tag-to-property. */
export function propertyWritePolicy(operation: ChangeOperation): PropertyWritePolicy {
  return operation.kind === 'mapPropertyValues'
    || operation.kind === 'convertPropertyType'
    || operation.kind === 'convertTagsToProperty'
    ? 'confirm-data-only'
    : 'strict-declaration';
}
function summarizeValues(items: readonly PreviewItem[]): ValueSummary {
  const summary: ValueSummary = { ready: 0, needsConfirmation: 0, unconvertible: 0, noop: 0 };
  for (const item of items) {
    const analysis = item.valueAnalysis;
    if (!analysis) continue;
    if (analysis.outcome === 'unconvertible') summary.unconvertible++;
    else if (analysis.outcome === 'noop') summary.noop++;
    else if (item.state === 'ready') summary.ready++;
    else if (item.state === 'conflict') summary.needsConfirmation++;
  }
  return summary;
}
interface Capture {
  path: string;
  beforeContent: string;
  beforeHash: string;
  file?: FileMeta;
  decoded?: DecodedNote;
  bodyTags: readonly CachedTag[];
  issue?: import('../domain/errors').IssueCode;
}
interface Session {
  view: PreviewView;
  request: PreviewRequest;
  restrictedPaths?: readonly string[];
  captures: Capture[];
  decisions: Map<string, PreviewDecision>;
  prepared: PreparedChange[];
  settingsFingerprint: string;
  types: Awaited<ReturnType<TypeMigration['plan']>>;
  compiledMapping?: CompiledValueMapping;
  compiledBranch?: CompiledTagBranch;
  compiledTagProperty?: CompiledTagProperty;
  declaration?: DeclarationInfo;
  consumed: boolean;
  busy: boolean;
  stale: Set<string>;
}
export class ChangePlanner {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly vault: VaultPort, private readonly store: SnapshotStore, private readonly getSettings: () => PropCraftSettings,
    private readonly codec: NoteCodecPort, private readonly typeMigration: TypeMigration) {}
  async createPreview(request: PreviewRequest, signal?: AbortSignal, options: { paths?: readonly string[]; retryOf?: string } = {}): Promise<PreviewView> {
    validateOperation(request.operation);
    const scope = validateScope(request.scope, this.vault.getFolders());
    const operation = structuredClone(request.operation);
    if (operation.kind === 'renameTag' || operation.kind === 'mergeTag') {
      operation.from = tagWithHash(operation.from);
      operation.to = validateTagPath(operation.to);
    } else if (operation.kind === 'migrateTagBranch') {
      operation.from = operation.includeDescendants ? validateTagBranchPrefix(operation.from) : validateTagPath(operation.from);
      operation.to = operation.includeDescendants ? validateTagBranchPrefix(operation.to) : validateTagPath(operation.to);
    } else if (operation.kind === 'convertTagsToProperty') {
      operation.rules = operation.rules.map(rule => ({ ...rule, tag: validateTagPath(rule.tag) }));
    }
    const settings = structuredClone(this.getSettings()), fingerprint = exclusionFingerprint(settings);
    const manual = new Set(scope.manuallyExcludedPaths), allowed = options.paths ? new Set(options.paths) : null;
    const paths = this.vault.getMarkdownFiles().map(file => file.path).filter(path => inBase(path, scope.base) && !shouldExclude(path, settings) && (!allowed || allowed.has(path))).sort();
    signal?.throwIfAborted();
    const types = await this.typeMigration.plan(operation), captures: Capture[] = [];
    signal?.throwIfAborted();
    const compiledMapping = operation.kind === 'mapPropertyValues' ? compileValueMapping(operation) : undefined;
    const compiledBranch = operation.kind === 'migrateTagBranch' ? compileTagBranch(operation) : undefined;
    const compiledTagProperty = operation.kind === 'convertTagsToProperty' ? compileTagProperty(operation) : undefined;
    const declaration: DeclarationInfo | undefined = operation.kind === 'mapPropertyValues'
      || operation.kind === 'convertPropertyType'
      || operation.kind === 'convertTagsToProperty'
      ? (types.snapshot.kind === 'unsupported' ? { kind: 'unavailable' } : types.targetType ? { kind: 'known', type: types.targetType } : { kind: 'absent' })
      : undefined;
    const needsTags = scope.conditions.some(c => c.kind === 'tag') || isTagOperation(operation);
    let unknown = 0, matched = 0, manuallyExcluded = 0;
    for (let index = 0; index < paths.length; index += 16) {
      signal?.throwIfAborted();
      const batch = await Promise.all(paths.slice(index, index + 16).map(async path => {
        const capture: Capture = { path, beforeContent: '', beforeHash: '', bodyTags: [] };
        try {
          capture.beforeContent = await this.vault.readText(path);
          signal?.throwIfAborted();
          capture.beforeHash = await sha256Hex(capture.beforeContent);
          const decoded = this.codec.decode(capture.beforeContent);
          if (!decoded.ok) { capture.issue = decoded.code; return capture; }
          capture.decoded = decoded.note;
          const tags = needsTags ? await this.vault.readBoundTags(path, capture.beforeContent, signal) : { ok: true as const, bodyTags: [] };
          capture.bodyTags = tags.ok ? tags.bodyTags : [];
          capture.file = fileMeta(path, this.vault.getMtime(path), { frontmatter: decoded.note.frontmatter, bodyTags: tags.ok ? tags.bodyTags : [] });
          capture.file.tagsComplete = tags.ok && capture.file.tagsComplete;
          const match = matchScope(capture.file, scope);
          if (match === 'no-match') return null;
          if (match === 'unknown') capture.issue = 'metadata-stale';
          return capture;
        } catch (error) {
          signal?.throwIfAborted();
          capture.issue = issueCode(error, 'read-failed'); return capture;
        }
      }));
      for (const capture of batch) if (capture) {
        if (capture.issue) unknown++; else { matched++; if (manual.has(capture.path)) manuallyExcluded++; }
        if (!manual.has(capture.path)) captures.push(capture);
      }
      await new Promise<void>(resolve => { window.setTimeout(resolve, 0); });
    }
    signal?.throwIfAborted();
    const id = `pc_${crypto.randomUUID().replace(/-/g, '')}`;
    const view: PreviewView = { id, revision: 1, createdAt: Date.now(), operation, items: [], summary: summarizePreview([]),
      snapshotRevision: this.store.get()?.revision ?? 0, scopeSummary: { base: scope.base, conditions: scope.conditions, effective: matched - manuallyExcluded, matched, manual: manuallyExcluded, unknown }, typeSummary: types.summary, retryOf: options.retryOf };
    const session: Session = {
      view,
      request: { scope, operation },
      restrictedPaths: options.paths ? [...options.paths] : undefined,
      captures,
      decisions: new Map(),
      prepared: [],
      settingsFingerprint: fingerprint,
      types,
      compiledMapping,
      compiledBranch,
      compiledTagProperty,
      declaration,
      consumed: false,
      busy: false,
      stale: new Set(),
    };
    for (const capture of captures) session.decisions.set(capture.path, { path: capture.path, beforeHash: capture.beforeHash, selected: true });
    await this.calculate(session, signal);
    signal?.throwIfAborted();
    this.sessions.set(id, session);
    return structuredClone(session.view);
  }
  private async calculate(session: Session, signal?: AbortSignal): Promise<void> {
    const items: PreviewItem[] = [], prepared: PreparedChange[] = [];
    const op = session.request.operation;
    if (op.kind === 'migrateTagBranch' && session.compiledBranch) {
      const mappingRecords: { path: string; mappings: readonly (TagBranchTargetMapping & { sourceId: string })[]; existingTagIds: readonly string[] }[] = [];
      let anyOverlap = false;
      for (let index = 0; index < session.captures.length; index++) {
        signal?.throwIfAborted();
        const capture = session.captures[index];
        const decision = session.decisions.get(capture.path)!;
        const evaluated = await evaluateBranchCapture(capture, decision, session.compiledBranch, this.codec, this.vault, session.stale.has(capture.path), signal);
        signal?.throwIfAborted();
        if (evaluated.mappingRecord) mappingRecords.push(evaluated.mappingRecord);
        if (evaluated.overlap) anyOverlap = true;
        if (evaluated.item.state === 'ready' && evaluated.item.disposition === 'execute' && decision.selected && !session.stale.has(capture.path) && evaluated.afterContent !== undefined && evaluated.afterContent !== capture.beforeContent) {
          prepared.push({
            path: capture.path,
            beforeContent: capture.beforeContent,
            beforeHash: capture.beforeHash,
            afterContent: evaluated.afterContent,
            expectedAfterHash: await sha256Hex(evaluated.afterContent),
            decision: { ...decision },
          });
        }
        items.push(evaluated.item);
        if (index > 0 && index % 16 === 0) await new Promise<void>(resolve => { window.setTimeout(resolve, 0); });
      }
      signal?.throwIfAborted();
      const tagBranchSummary: TagBranchSummary = buildTagBranchSummary(this.store.get(), this.vault, session.captures, mappingRecords, anyOverlap, session.stale);
      session.prepared = prepared;
      session.view = { ...session.view, items, summary: summarizePreview(items), typeSummary: session.types.summary, tagBranchSummary };
      return;
    }

    if (op.kind === 'convertTagsToProperty' && session.compiledTagProperty) {
      for (let index = 0; index < session.captures.length; index++) {
        signal?.throwIfAborted();
        const capture = session.captures[index];
        const decision = session.decisions.get(capture.path)!;
        const evaluated = await evaluateTagPropertyCapture(capture, decision, session.compiledTagProperty, session.declaration, this.codec, this.vault, session.stale.has(capture.path), signal);
        signal?.throwIfAborted();
        if (evaluated.item.state === 'ready' && evaluated.item.disposition === 'execute' && decision.selected && !session.stale.has(capture.path) && evaluated.afterContent !== undefined && evaluated.afterContent !== capture.beforeContent) {
          prepared.push({
            path: capture.path,
            beforeContent: capture.beforeContent,
            beforeHash: capture.beforeHash,
            afterContent: evaluated.afterContent,
            expectedAfterHash: await sha256Hex(evaluated.afterContent),
            decision: { ...decision },
          });
        }
        items.push(evaluated.item);
        if (index > 0 && index % 16 === 0) await new Promise<void>(resolve => { window.setTimeout(resolve, 0); });
      }
      signal?.throwIfAborted();
      session.prepared = prepared;
      session.view = { ...session.view, items, summary: summarizePreview(items), typeSummary: session.types.summary };
      return;
    }

    const isValueOp = op.kind === 'mapPropertyValues' || op.kind === 'convertPropertyType';
    const context: ValueAnalyzeContext = { mapping: session.compiledMapping, declaration: session.declaration };
    for (let index = 0; index < session.captures.length; index++) {
      signal?.throwIfAborted();
      const capture = session.captures[index];
      const decision = session.decisions.get(capture.path)!;
      const item: PreviewItem = { path: capture.path, state: 'blocked', disposition: 'blocked', decision: { ...decision }, conflict: false, allowedStrategies: [], diffs: [], reason: capture.issue };
      if (capture.file && capture.decoded && !capture.issue) {
        const analyzed: AnalyzedOperation = analyzeOperation(capture.file, op, decision, isValueOp ? context : undefined);
        item.state = analyzed.state; item.reason = analyzed.reason; item.conflict = analyzed.conflict;
        item.allowedStrategies = analyzed.allowedStrategies; item.ambiguousDate = analyzed.ambiguousDate;
        item.valueAnalysis = analyzed.valueAnalysis;
        if (analyzed.conflict && (op.kind === 'renameProperty' || op.kind === 'mergeProperty')) {
          const { from, to } = op;
          item.conflictValues = { source: `${from}: ${JSON.stringify(capture.file.rawFrontmatter[from])}`, target: `${to}: ${JSON.stringify(capture.file.rawFrontmatter[to])}` };
        }
        item.disposition = analyzed.state === 'ready' ? 'execute' : analyzed.state === 'noop' ? 'noop' : analyzed.state === 'conflict' ? 'skip' : 'blocked';
        if (analyzed.change) {
          const targetKey = op.kind === 'renameProperty' || op.kind === 'mergeProperty' ? op.to : 'key' in op ? op.key : undefined;
          const propertyWrite = op.kind !== 'renameTag' && op.kind !== 'mergeTag' && op.kind !== 'deleteProperty';
          // New value operations resolved declaration policy inside analysis; legacy writes stay strict.
          if (!isValueOp && propertyWrite && (session.types.snapshot.kind === 'unsupported' || targetKey && !isTypeCompatible(session.types.targetType, analyzed.change.afterFrontmatter[targetKey]))) {
            item.state = 'blocked'; item.disposition = 'blocked'; item.reason = session.types.snapshot.kind === 'unsupported' ? 'type-config-unsupported' : 'type-incompatible';
          } else {
            const encoded = this.codec.compose(capture.beforeContent, capture.decoded, analyzed.change);
            if (!encoded.ok) { item.state = 'blocked'; item.disposition = 'blocked'; item.reason = encoded.code; }
            else if (op.kind === 'renameTag' || op.kind === 'mergeTag') {
              const afterDecoded = this.codec.decode(encoded.content);
              signal?.throwIfAborted();
              const afterTags = afterDecoded.ok ? await this.vault.readBoundTags(capture.path, encoded.content, signal) : null;
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
              if (!sem.ok) { item.state = 'blocked'; item.disposition = 'blocked'; item.reason = 'tag-semantics-changed'; }
              else {
                item.diffs = diffForFile(analyzed.change, capture.beforeContent);
                if (encoded.content === capture.beforeContent) { item.state = 'noop'; item.disposition = 'noop'; item.reason = 'no-change'; }
                else if (analyzed.state === 'ready' && decision.selected && !session.stale.has(capture.path)) prepared.push({ path: capture.path, beforeContent: capture.beforeContent, beforeHash: capture.beforeHash,
                  afterContent: encoded.content, expectedAfterHash: await sha256Hex(encoded.content), decision: { ...decision } });
              }
            } else {
              item.diffs = diffForFile(analyzed.change, capture.beforeContent);
              if (encoded.content === capture.beforeContent) { item.state = 'noop'; item.disposition = 'noop'; item.reason = 'no-change'; }
              else if (analyzed.state === 'ready' && decision.selected && !session.stale.has(capture.path)) prepared.push({ path: capture.path, beforeContent: capture.beforeContent, beforeHash: capture.beforeHash,
                afterContent: encoded.content, expectedAfterHash: await sha256Hex(encoded.content), decision: { ...decision } });
            }
          }
        }
      }
      if (item.disposition === 'execute' && !decision.selected) { item.disposition = 'skip'; item.reason = 'user-unselected'; }
      if (session.stale.has(capture.path)) { item.stale = true; item.disposition = 'skip'; item.reason = 'file-stale'; }
      items.push(item);
    }
    session.prepared = prepared;
    const valueSummary = items.some(item => item.valueAnalysis) ? summarizeValues(items) : undefined;
    session.view = { ...session.view, items, summary: summarizePreview(items), typeSummary: !prepared.length && session.types.summary.kind === 'add' ? { ...session.types.summary, kind: 'none' } : session.types.summary, ...(valueSummary ? { valueSummary } : {}) };
  }
  async revisePreview(id: string, expectedRevision: number, patches: readonly PreviewDecisionPatch[]): Promise<PreviewView> {
    const session = this.session(id, expectedRevision);
    if (session.busy) throw new OperationError('operation-busy');
    const decisions = new Map(session.decisions);
    for (const patch of patches) {
      const previous = decisions.get(patch.path);
      if (!previous || previous.beforeHash !== patch.beforeHash
        || patch.selected !== undefined && typeof patch.selected !== 'boolean'
        || patch.dateInterpretationConfirmed !== undefined && typeof patch.dateInterpretationConfirmed !== 'boolean'
        || patch.valueLossConfirmed !== undefined && typeof patch.valueLossConfirmed !== 'boolean'
        || patch.declaredTypeMismatchConfirmed !== undefined && typeof patch.declaredTypeMismatchConfirmed !== 'boolean'
        || patch.individual !== undefined && typeof patch.individual !== 'boolean') {
        throw new OperationError('invalid-decision');
      }
      const item = session.view.items.find(candidate => candidate.path === patch.path);
      if (!item) throw new OperationError('invalid-decision');
      if (patch.merge !== undefined && !item.allowedStrategies.includes(patch.merge)) throw new OperationError('invalid-decision');

      const nextDecision: PreviewDecision = { ...previous };
      if (patch.selected !== undefined) nextDecision.selected = patch.selected;
      if (patch.merge !== undefined) nextDecision.merge = patch.merge;
      if (patch.individual !== undefined) nextDecision.individual = patch.individual;

      let switchedTagCandidate = false;
      if (patch.tagPropertyResolution !== undefined) {
        const tagAnalysis = item.tagAnalysis;
        if (!tagAnalysis || !tagAnalysis.requiresResolution) throw new OperationError('invalid-decision');
        if (patch.tagPropertyResolution === null) {
          switchedTagCandidate = previous.tagPropertyResolution !== undefined;
          delete nextDecision.tagPropertyResolution;
          delete nextDecision.declaredTypeMismatchConfirmed;
        } else {
          if (!isValidTagPropertyResolution(patch.tagPropertyResolution)) throw new OperationError('invalid-decision');
          const allowed = tagAnalysis.allowedResolutions.some(candidate => sameTagResolution(candidate, patch.tagPropertyResolution!));
          if (!allowed) throw new OperationError('invalid-decision');
          switchedTagCandidate = !sameTagResolution(previous.tagPropertyResolution, patch.tagPropertyResolution);
          nextDecision.tagPropertyResolution = structuredClone(patch.tagPropertyResolution);
          if (switchedTagCandidate) delete nextDecision.declaredTypeMismatchConfirmed;
        }
        // Reject switching/withdrawing a candidate and confirming a new declaration in the same patch.
        if (switchedTagCandidate && patch.declaredTypeMismatchConfirmed === true) {
          throw new OperationError('invalid-decision');
        }
      }

      const required = item.valueAnalysis?.requiredConfirmations;
      if (patch.valueLossConfirmed !== undefined) {
        if (!required?.includes('value-loss')) throw new OperationError('invalid-decision');
        nextDecision.valueLossConfirmed = patch.valueLossConfirmed;
      }
      if (patch.dateInterpretationConfirmed !== undefined) {
        if (required && !required.includes('date-interpretation')) throw new OperationError('invalid-decision');
        nextDecision.dateInterpretationConfirmed = patch.dateInterpretationConfirmed;
      }
      if (patch.declaredTypeMismatchConfirmed !== undefined) {
        if (switchedTagCandidate) {
          if (patch.declaredTypeMismatchConfirmed) throw new OperationError('invalid-decision');
        } else {
          if (!required?.includes('declared-type-mismatch')) throw new OperationError('invalid-decision');
          nextDecision.declaredTypeMismatchConfirmed = patch.declaredTypeMismatchConfirmed;
        }
      }

      decisions.set(patch.path, nextDecision);
    }
    session.busy = true;
    const previous = session.decisions; session.decisions = decisions;
    try {
      await this.calculate(session); session.view = { ...session.view, revision: expectedRevision + 1 }; return structuredClone(session.view);
    } catch (error) { session.decisions = previous; throw error; }
    finally { session.busy = false; }
  }
  async refreshValidity(id: string, revision: number): Promise<PreviewView> {
    const session = this.session(id, revision);
    if (session.busy) throw new OperationError('operation-busy');
    session.busy = true;
    try {
      if (exclusionFingerprint(this.getSettings()) !== session.settingsFingerprint) session.view = { ...session.view, invalid: 'plan-invalid' };
      try { await this.typeMigration.verifyBaseline(session.types.baseline); } catch { session.view = { ...session.view, invalid: 'type-config-stale' }; }
      for (const capture of session.captures) {
        try { if (await this.vault.readText(capture.path) !== capture.beforeContent) session.stale.add(capture.path); }
        catch { session.stale.add(capture.path); }
      }
      await this.calculate(session); session.view = { ...session.view, revision: revision + 1 };
      return structuredClone(session.view);
    } finally { session.busy = false; }
  }
  getPrepared(id: string, expectedRevision: number): PreparedPlan {
    const s = this.session(id, expectedRevision);
    if (s.busy || s.view.invalid || !s.prepared.length || exclusionFingerprint(this.getSettings()) !== s.settingsFingerprint) throw new OperationError('plan-invalid');
    validateOperation(s.request.operation);
    s.consumed = true;
    return structuredClone({ id, revision: expectedRevision, createdAt: s.view.createdAt, operation: s.request.operation, scope: s.request.scope,
      scopeSummary: s.view.scopeSummary, settingsFingerprint: s.settingsFingerprint, changes: s.prepared,
      skipped: s.view.items.filter(item => item.disposition !== 'execute').map(item => ({ path: item.path, reason: item.reason ?? 'no-change' })),
      typePatch: s.types.patch, typeBaseline: s.types.baseline, retryOf: s.view.retryOf });
  }
  async recreate(id: string, staleOnly = false, signal?: AbortSignal): Promise<PreviewView> {
    const session = this.sessions.get(id);
    if (!session) throw new OperationError('plan-invalid');
    const paths = staleOnly
      ? [...session.stale]
      : session.restrictedPaths ? [...session.restrictedPaths] : undefined;
    return this.createPreview(session.request, signal, { paths, retryOf: session.view.retryOf });
  }
  discard(id: string): void { this.sessions.delete(id); }
  private session(id: string, revision: number): Session {
    const session = this.sessions.get(id);
    if (!session || session.consumed || session.view.revision !== revision) throw new OperationError('plan-invalid');
    return session;
  }
}
