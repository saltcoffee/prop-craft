import type { ExecutionResult, PreviewView } from '../domain/preview';
import type { RecoveryPreview, RecoveryResult } from '../domain/recovery';
import type { IssueCode } from '../domain/errors';
import { OperationError } from '../domain/errors';
import type { ChangePlanner } from './ChangePlanner';
import type { ChangeExecutor, ExecutionProgress } from './ChangeExecutor';
import type { JournalService } from './JournalService';
import type { UndoService } from './UndoService';

export type OperationState =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  | { kind: 'running' | 'stopping'; progress: ExecutionProgress }
  | { kind: 'result'; result: ExecutionResult }
  | { kind: 'recovery-preview'; preview: RecoveryPreview }
  | { kind: 'recovering' }
  | { kind: 'recovery-result'; result: RecoveryResult }
  | { kind: 'recovery-required'; transactionIds: string[]; issue?: IssueCode };
export class OperationCoordinator {
  private state: OperationState = { kind: 'idle' };
  private busy = false;
  private unloaded = false;
  private initialized = false;
  private reviewIds: string[] = [];
  private abort: AbortController | null = null;
  private readonly listeners = new Set<(state: OperationState) => void>();
  constructor(private readonly planner: ChangePlanner, private readonly executor: ChangeExecutor, private readonly journal: JournalService, private readonly undo: UndoService) {}
  getState(): OperationState { return this.state; }
  isBusy(): boolean { return this.busy; }
  subscribe(listener: (state: OperationState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private set(state: OperationState): void { this.state = state; if (!this.unloaded) for (const listener of this.listeners) {
    try { listener(state); } catch { /* A closed view must not interrupt a running task. */ }
  } }
  async initialize(): Promise<void> {
    try { await this.refreshReview(); } catch { this.reviewIds = ['unavailable']; }
    this.initialized = true;
    if (this.reviewIds.length) this.set({ kind: 'recovery-required', transactionIds: this.reviewIds, ...(this.reviewIds[0] === 'unavailable' ? { issue: 'journal-unavailable' as const } : {}) });
  }
  private acquire(recovery = false): void {
    if (this.busy || this.unloaded || !this.initialized) throw new OperationError('operation-busy');
    if (!recovery && this.reviewIds.length) throw new OperationError('recovery-required');
    this.busy = true;
  }
  private async refreshReview(): Promise<void> {
    const metas = await this.journal.list();
    this.reviewIds = metas.filter(meta => meta.needsReconciliation && meta.kind === 'v2').map(meta => meta.transactionId);
  }
  async refreshStatus(): Promise<void> {
    this.acquire(true);
    try { await this.refreshReview(); if (this.state.kind === 'recovery-required') this.dismiss(); }
    finally { this.busy = false; }
  }
  async apply(id: string, revision: number): Promise<void> {
    this.acquire();
    this.abort = new AbortController();
    try {
      const plan = this.planner.getPrepared(id, revision);
      this.set({ kind: 'preparing' });
      const result = await this.executor.execute(plan, { signal: this.abort.signal, onProgress: progress => {
        this.set({ kind: this.abort?.signal.aborted ? 'stopping' : 'running', progress });
      } });
      await this.refreshReview();
      result.requiresReconciliation ||= this.reviewIds.includes(result.transactionId);
      this.set({ kind: 'result', result });
    } catch (error) {
      await this.refreshReview().catch(() => { this.reviewIds = ['unavailable']; });
      this.set(this.reviewIds.length ? { kind: 'recovery-required', transactionIds: this.reviewIds } : { kind: 'idle' });
      throw error;
    } finally { this.planner.discard(id); this.busy = false; this.abort = null; }
  }
  cancel(): void {
    this.abort?.abort();
    if (this.state.kind === 'running') this.set({ kind: 'stopping', progress: this.state.progress });
  }
  async retry(id: string, mode: 'unfinished' | 'failed' | 'not-run' | 'stale' = 'unfinished'): Promise<PreviewView> {
    this.acquire();
    try {
      const loaded = await this.journal.get(id);
      if (loaded.kind !== 'v2' || !loaded.state) throw new OperationError('journal-invalid');
      const statuses = mode === 'unfinished' ? ['failed', 'not-run'] : [mode];
      const paths = loaded.state.entries.filter(entry => statuses.includes(entry.execution)).map(entry => entry.path);
      if (!paths.length) throw new OperationError('plan-invalid');
      // Rebuild from current contents. Individual destructive choices are never inherited.
      return await this.planner.createPreview({ operation: loaded.transaction.operation, scope: loaded.transaction.scope }, undefined, { paths, retryOf: id });
    } finally { this.busy = false; }
  }
  async viewResult(id: string): Promise<void> {
    this.acquire(true);
    try {
      const loaded = await this.journal.get(id);
      if (loaded.kind !== 'v2' || !loaded.state) throw new OperationError('evidence-missing');
      const items: ExecutionResult['items'] = loaded.state.entries.map(entry => ({ path: entry.path,
        status: entry.execution === 'pending' || entry.execution === 'applying' ? 'uncertain' : entry.execution, reason: entry.reason ?? (entry.execution === 'applied' ? 'applied' : entry.execution === 'not-run' ? 'not-run' : 'uncertain') }));
      items.push(...loaded.transaction.skipped.map(item => ({ ...item, status: 'skipped' as const })));
      this.set({ kind: 'result', result: { transactionId: id, items, typeStatus: loaded.state.typeExecution, durationMs: 0, cancelled: false, requiresReconciliation: this.reviewIds.includes(id) } });
    } finally { this.busy = false; }
  }
  async previewRecovery(id: string): Promise<void> {
    this.acquire(true);
    try { if (this.state.kind === 'recovery-preview') this.undo.discard(this.state.preview.id); this.set({ kind: 'preparing' }); this.set({ kind: 'recovery-preview', preview: await this.undo.preview(id) }); }
    catch (error) { this.dismiss(); throw error; }
    finally { this.busy = false; }
  }
  async recover(id: string, revision: number): Promise<void> {
    this.acquire(true); this.abort = new AbortController();
    try {
      this.set({ kind: 'recovering' });
      const result = await this.undo.recover(id, revision, this.abort.signal);
      await this.refreshReview();
      result.requiresReconciliation ||= this.reviewIds.includes(result.transactionId);
      this.set({ kind: 'recovery-result', result });
    } catch (error) { this.dismiss(); throw error; }
    finally { this.busy = false; this.abort = null; }
  }
  async reconcile(id: string): Promise<void> {
    this.acquire(true);
    try {
      if (this.state.kind === 'recovery-preview') this.undo.discard(this.state.preview.id);
      this.set({ kind: 'preparing' });
      const preview = await this.undo.reconcile(id);
      await this.refreshReview();
      this.set({ kind: 'recovery-preview', preview });
    } catch (error) { this.dismiss(); throw error; }
    finally { this.busy = false; }
  }
  async removeOne(id: string): Promise<void> {
    this.acquire(true);
    try { await this.journal.removeOne(id); await this.refreshReview(); }
    finally { this.busy = false; }
  }
  dismiss(): void {
    if (this.state.kind === 'recovery-preview') this.undo.discard(this.state.preview.id);
    this.set(this.reviewIds.length ? { kind: 'recovery-required', transactionIds: this.reviewIds } : { kind: 'idle' });
  }
  dispose(): void { this.unloaded = true; this.cancel(); this.listeners.clear(); }
}
