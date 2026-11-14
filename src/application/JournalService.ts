import type { PreparedPlan } from '../domain/preview';
import { OperationError } from '../domain/errors';
import { canRemoveJournal, initialState, needsReconciliation, utf8Bytes, type JournalListItem, type JournalStateV2, type JournalTransactionV2, type LoadedJournal } from '../domain/journal';
import type { JournalStore } from '../ports/JournalStore';
import type { PropCraftSettings } from '../settings-model';
export type { JournalStore } from '../ports/JournalStore';

export class JournalService {
  private readonly activeStates = new Map<string, { state: JournalStateV2; budget?: number }>();
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly store: JournalStore, private readonly getSettings: () => PropCraftSettings) {}
  async prepare(plan: PreparedPlan): Promise<JournalTransactionV2> {
    if (!plan.changes.length) throw new OperationError('plan-invalid');
    const transaction: JournalTransactionV2 = { schemaVersion: 2, transactionId: `tx_${crypto.randomUUID().replace(/-/g, '')}`, planId: plan.id,
      createdAt: Date.now(), operation: plan.operation, scope: plan.scope, scopeSummary: plan.scopeSummary, retryOf: plan.retryOf,
      entries: plan.changes.map(({ path, beforeContent, beforeHash, expectedAfterHash }) => ({ path, beforeContent, beforeHash, expectedAfterHash })),
      skipped: plan.skipped, typePatch: plan.typePatch, stateBudgetBytes: 1 };
    const state = initialState(transaction);
    transaction.stateBudgetBytes = utf8Bytes(JSON.stringify(state)) + state.entries.length * 256 + 4096;
    const metas = await this.store.list(), settings = this.getSettings();
    const needed = utf8Bytes(JSON.stringify(transaction)) + transaction.stateBudgetBytes;
    if (!Number.isSafeInteger(settings.journalMaxTransactions) || settings.journalMaxTransactions < 1 || metas.length >= settings.journalMaxTransactions
      || !Number.isFinite(settings.journalMaxBytes) || needed + metas.reduce((total, meta) => total + meta.reservedBytes, 0) > settings.journalMaxBytes) throw new OperationError('journal-capacity');
    try {
      await this.store.prepare(transaction, state);
      const loaded = await this.store.load(transaction.transactionId);
      if (loaded.kind !== 'v2' || !loaded.state || JSON.stringify(loaded.transaction) !== JSON.stringify(transaction)
        || JSON.stringify(loaded.state) !== JSON.stringify(state)) throw new OperationError('journal-invalid');
    } catch (error) { throw error instanceof OperationError ? error : new OperationError('journal-unavailable'); }
    this.activeStates.set(transaction.transactionId, { state: structuredClone(state), budget: transaction.stateBudgetBytes });
    return transaction;
  }
  update(id: string, change: (state: JournalStateV2) => void): Promise<JournalStateV2> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      let active = this.activeStates.get(id);
      if (!active) {
        const loaded = await this.store.load(id);
        if (loaded.kind !== 'v2' && loaded.kind !== 'legacy' || !loaded.state) throw new OperationError('evidence-missing');
        active = { state: loaded.state, ...(loaded.kind === 'v2' ? { budget: loaded.transaction.stateBudgetBytes } : {}) };
      }
      const state = structuredClone(active.state), revision = state.revision;
      change(state); state.revision++; state.updatedAt = Date.now();
      if (active.budget !== undefined && utf8Bytes(JSON.stringify(state)) > active.budget) throw new OperationError('journal-capacity');
      try { await this.store.checkpoint(id, revision, state); }
      catch (error) { this.activeStates.delete(id); throw error; }
      this.activeStates.set(id, { state, budget: active.budget });
      return state;
    });
    this.queues.set(id, next);
    // A failed checkpoint invalidates this submission chain, not future reconciliation.
    void next.finally(() => { if (this.queues.get(id) === next) this.queues.delete(id); }).catch(() => undefined);
    return next;
  }
  release(id: string): void { this.activeStates.delete(id); }
  async initializeState(id: string, state: JournalStateV2): Promise<void> { await this.store.initializeState(id, state); }
  async get(id: string): Promise<LoadedJournal> { return this.store.load(id); }
  async list(): Promise<JournalListItem[]> {
    return (await this.store.list()).map(({ id, loaded, bytes, reservedBytes }): JournalListItem => {
      if (loaded.kind === 'invalid' || loaded.kind === 'unsupported') return { transactionId: id, kind: loaded.kind, issue: loaded.issue, createdAt: 0, fileCount: 0, bytes, reservedBytes, canRemove: false, needsReconciliation: true };
      const { transaction: tx, state } = loaded;
      const counts: JournalListItem['counts'] = {};
      for (const entry of state?.entries ?? []) counts[entry.execution] = (counts[entry.execution] ?? 0) + 1;
      return { transactionId: id, kind: loaded.kind, createdAt: tx.createdAt, operation: tx.operation,
        fileCount: tx.entries.length, bytes, reservedBytes, canRemove: canRemoveJournal(loaded), needsReconciliation: needsReconciliation(loaded), counts,
        execution: state?.execution ?? (loaded.kind === 'legacy' ? loaded.transaction.status : 'interrupted'), recovery: state?.recovery ?? 'none',
        ...(loaded.kind === 'v2' ? { scopeSummary: loaded.transaction.scopeSummary, retryOf: loaded.transaction.retryOf, issue: loaded.stateIssue } : {}) };
    }).sort((a, b) => b.createdAt - a.createdAt);
  }
  async removeOne(id: string): Promise<void> {
    const loaded = await this.store.load(id);
    if (this.queues.has(id) || !canRemoveJournal(loaded)) throw new OperationError('recovery-required');
    await this.store.removeOne(id);
  }
}
