import type { ChangeOperation, FileMeta } from '../domain/models';
import type { AnalyzedOperation, PreparedChange, PreparedPlan, PreviewDecision, PreviewDecisionPatch, PreviewItem, PreviewView } from '../domain/preview';
import { summarizePreview } from '../domain/preview';
import { inBase, matchScope, validateScope, type ScopeQuery } from '../domain/scope';
import { validateOperation } from '../domain/operation';
import { analyzeOperation } from '../domain/plan';
import { diffForFile } from '../domain/diff';
import { OperationError, issueCode } from '../domain/errors';
import { isTypeCompatible } from '../domain/type-config';
import { tagWithHash } from '../domain/normalize';
import type { NoteCodecPort, DecodedNote } from '../ports/NoteCodecPort';
import type { VaultPort } from '../ports/VaultPort';
import type { PropCraftSettings } from '../settings-model';
import { sha256Hex } from '../infrastructure/hash';
import type { SnapshotStore } from './SnapshotStore';
import { exclusionFingerprint, shouldExclude } from './exclude';
import { fileMeta } from './file-meta';
import type { TypeMigration } from './TypeMigration';

export interface PreviewRequest { scope: ScopeQuery; operation: ChangeOperation }
interface Capture { path: string; beforeContent: string; beforeHash: string; file?: FileMeta; decoded?: DecodedNote; issue?: import('../domain/errors').IssueCode }
interface Session {
  view: PreviewView;
  request: PreviewRequest;
  captures: Capture[];
  decisions: Map<string, PreviewDecision>;
  prepared: PreparedChange[];
  settingsFingerprint: string;
  types: Awaited<ReturnType<TypeMigration['plan']>>;
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
    if (operation.kind === 'renameTag' || operation.kind === 'mergeTag') { operation.from = tagWithHash(operation.from); operation.to = tagWithHash(operation.to); }
    const settings = structuredClone(this.getSettings()), fingerprint = exclusionFingerprint(settings);
    const manual = new Set(scope.manuallyExcludedPaths), allowed = options.paths ? new Set(options.paths) : null;
    const paths = this.vault.getMarkdownFiles().map(file => file.path).filter(path => inBase(path, scope.base) && !shouldExclude(path, settings) && (!allowed || allowed.has(path))).sort();
    const types = await this.typeMigration.plan(operation), captures: Capture[] = [];
    let unknown = 0, matched = 0, manuallyExcluded = 0;
    for (let index = 0; index < paths.length; index += 16) {
      signal?.throwIfAborted();
      const batch = await Promise.all(paths.slice(index, index + 16).map(async path => {
        const capture: Capture = { path, beforeContent: '', beforeHash: '' };
        try {
          capture.beforeContent = await this.vault.readText(path);
          signal?.throwIfAborted();
          capture.beforeHash = await sha256Hex(capture.beforeContent);
          const decoded = this.codec.decode(capture.beforeContent);
          if (!decoded.ok) { capture.issue = decoded.code; return capture; }
          capture.decoded = decoded.note;
          const needsTags = scope.conditions.some(c => c.kind === 'tag') || operation.kind === 'renameTag' || operation.kind === 'mergeTag';
          const tags = needsTags ? await this.vault.readBoundTags(path, capture.beforeContent, signal) : { ok: true as const, bodyTags: [] };
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
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    signal?.throwIfAborted();
    const id = `pc_${crypto.randomUUID().replace(/-/g, '')}`;
    const view: PreviewView = { id, revision: 1, createdAt: Date.now(), operation, items: [], summary: summarizePreview([]),
      snapshotRevision: this.store.get()?.revision ?? 0, scopeSummary: { base: scope.base, conditions: scope.conditions, effective: matched - manuallyExcluded, matched, manual: manuallyExcluded, unknown }, typeSummary: types.summary, retryOf: options.retryOf };
    const session: Session = { view, request: { scope, operation }, captures, decisions: new Map(), prepared: [], settingsFingerprint: fingerprint, types, consumed: false, busy: false, stale: new Set() };
    for (const capture of captures) session.decisions.set(capture.path, { path: capture.path, beforeHash: capture.beforeHash, selected: true });
    await this.calculate(session);
    signal?.throwIfAborted();
    this.sessions.set(id, session);
    return structuredClone(session.view);
  }
  private async calculate(session: Session): Promise<void> {
    const items: PreviewItem[] = [], prepared: PreparedChange[] = [];
    for (const capture of session.captures) {
      const decision = session.decisions.get(capture.path)!;
      const item: PreviewItem = { path: capture.path, state: 'blocked', disposition: 'blocked', decision: { ...decision }, conflict: false, allowedStrategies: [], diffs: [], reason: capture.issue };
      if (capture.file && capture.decoded && !capture.issue) {
        const analyzed: AnalyzedOperation = analyzeOperation(capture.file, session.request.operation, decision);
        item.state = analyzed.state; item.reason = analyzed.reason; item.conflict = analyzed.conflict;
        item.allowedStrategies = analyzed.allowedStrategies; item.ambiguousDate = analyzed.ambiguousDate;
        if (analyzed.conflict && 'from' in session.request.operation && 'to' in session.request.operation) {
          const { from, to } = session.request.operation;
          item.conflictValues = { source: `${from}: ${JSON.stringify(capture.file.rawFrontmatter[from])}`, target: `${to}: ${JSON.stringify(capture.file.rawFrontmatter[to])}` };
        }
        item.disposition = analyzed.state === 'ready' ? 'execute' : analyzed.state === 'noop' ? 'noop' : analyzed.state === 'conflict' ? 'skip' : 'blocked';
        if (analyzed.change) {
          const targetKey = 'to' in session.request.operation ? session.request.operation.to : 'key' in session.request.operation ? session.request.operation.key : undefined;
          const propertyWrite = session.request.operation.kind !== 'renameTag' && session.request.operation.kind !== 'mergeTag' && session.request.operation.kind !== 'deleteProperty';
          if (propertyWrite && (session.types.snapshot.kind === 'unsupported' || targetKey && !isTypeCompatible(session.types.targetType, analyzed.change.afterFrontmatter[targetKey]))) {
            item.state = 'blocked'; item.disposition = 'blocked'; item.reason = session.types.snapshot.kind === 'unsupported' ? 'type-config-unsupported' : 'type-incompatible';
          } else {
            const encoded = this.codec.compose(capture.beforeContent, capture.decoded, analyzed.change);
            if (!encoded.ok) { item.state = 'blocked'; item.disposition = 'blocked'; item.reason = encoded.code; }
            else {
              item.diffs = diffForFile(analyzed.change, capture.beforeContent);
              if (encoded.content === capture.beforeContent) { item.state = 'noop'; item.disposition = 'noop'; item.reason = 'no-change'; }
              else if (decision.selected && !session.stale.has(capture.path)) prepared.push({ path: capture.path, beforeContent: capture.beforeContent, beforeHash: capture.beforeHash,
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
    session.view = { ...session.view, items, summary: summarizePreview(items), typeSummary: !prepared.length && session.types.summary.kind === 'add' ? { ...session.types.summary, kind: 'none' } : session.types.summary };
  }
  async revisePreview(id: string, expectedRevision: number, patches: readonly PreviewDecisionPatch[]): Promise<PreviewView> {
    const session = this.session(id, expectedRevision);
    if (session.busy) throw new OperationError('operation-busy');
    const decisions = new Map(session.decisions);
    for (const patch of patches) {
      const previous = decisions.get(patch.path);
      if (!previous || previous.beforeHash !== patch.beforeHash || patch.selected !== undefined && typeof patch.selected !== 'boolean'
        || patch.dateInterpretationConfirmed !== undefined && typeof patch.dateInterpretationConfirmed !== 'boolean') throw new OperationError('invalid-decision');
      const item = session.view.items.find(item => item.path === patch.path)!;
      if (patch.merge !== undefined && !item.allowedStrategies.includes(patch.merge)) throw new OperationError('invalid-decision');
      decisions.set(patch.path, { ...previous, ...patch });
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
    const paths = staleOnly ? [...session.stale] : undefined;
    return this.createPreview(session.request, signal, { paths, retryOf: session.view.retryOf });
  }
  discard(id: string): void { this.sessions.delete(id); }
  private session(id: string, revision: number): Session {
    const session = this.sessions.get(id);
    if (!session || session.consumed || session.view.revision !== revision) throw new OperationError('plan-invalid');
    return session;
  }
}
