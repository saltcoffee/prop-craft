import type { PreparedPlan, ExecutionItem, ExecutionResult } from '../domain/preview';
import { OperationError, issueCode } from '../domain/errors';
import { validateOperation } from '../domain/operation';
import { isNotePath } from '../domain/scope';
import type { JournalStateV2 } from '../domain/journal';
import type { VaultPort } from '../ports/VaultPort';
import type { PropCraftSettings } from '../settings-model';
import { sha256Hex } from '../infrastructure/hash';
import { exclusionFingerprint, shouldExclude } from './exclude';
import type { JournalService } from './JournalService';
import type { TypeMigration } from './TypeMigration';

export interface ExecutionProgress { done: number; total: number; currentPath: string; applied: number; failed: number }
export interface ExecuteOptions { signal?: AbortSignal; onProgress?: (progress: ExecutionProgress) => void; concurrency?: number }
export class ChangeExecutor {
  constructor(private readonly vault: VaultPort, private readonly journal: JournalService, private readonly getSettings: () => PropCraftSettings, private readonly types: TypeMigration) {}
  async execute(plan: PreparedPlan, options: ExecuteOptions = {}): Promise<ExecutionResult> {
    validateOperation(plan.operation);
    if (!plan.changes.length || exclusionFingerprint(this.getSettings()) !== plan.settingsFingerprint) throw new OperationError('plan-invalid');
    const limit = options.concurrency ?? this.getSettings().writeConcurrency;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16) throw new OperationError('input-invalid');
    const seen = new Set<string>();
    for (const change of plan.changes) {
      if (!isNotePath(change.path) || seen.has(change.path) || shouldExclude(change.path, this.getSettings())
        || await sha256Hex(change.beforeContent) !== change.beforeHash || await sha256Hex(change.afterContent) !== change.expectedAfterHash
        || change.beforeContent === change.afterContent) throw new OperationError('plan-invalid');
      seen.add(change.path);
    }
    const reportProgress = (progress: ExecutionProgress): void => {
      try { options.onProgress?.(progress); } catch { /* Observers cannot interrupt protected writes. */ }
    };
    const startedAt = Date.now(), transaction = await this.journal.prepare(plan), id = transaction.transactionId;
    const items = new Map<string, ExecutionItem>();
    for (const change of plan.changes) items.set(change.path, { path: change.path, status: 'not-run', reason: 'not-run' });
    let halted = false, done = 0, typeStatus = plan.typePatch ? 'pending' : 'none';
    const checkpoint = async (mutate: (state: JournalStateV2) => void): Promise<boolean> => {
      try { await this.journal.update(id, mutate); return true; }
      catch { halted = true; return false; }
    };
    if (!await checkpoint(state => { state.execution = 'running'; })) halted = true;
    if (!halted && !options.signal?.aborted) {
      try {
        await this.types.verifyBaseline(plan.typeBaseline);
        if (plan.typePatch) {
          if (await checkpoint(state => { state.typeExecution = 'applying'; })) {
            typeStatus = 'applying';
            await this.types.apply(plan.typePatch);
            typeStatus = 'applied';
            if (!await checkpoint(state => { state.typeExecution = 'applied'; })) typeStatus = 'uncertain';
          }
        }
      } catch (error) {
        halted = true;
        typeStatus = issueCode(error, 'uncertain') === 'type-config-stale' ? 'stale' : plan.typePatch && typeStatus === 'applying' ? 'uncertain' : 'failed';
        await checkpoint(state => { state.typeExecution = typeStatus === 'stale' ? 'stale' : typeStatus === 'uncertain' ? 'uncertain' : 'failed'; state.typeReason = issueCode(error, 'write-failed'); });
      }
    }
    reportProgress({ done: 0, total: plan.changes.length, currentPath: '', applied: 0, failed: 0 });
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, plan.changes.length) }, async () => {
      while (!halted && !options.signal?.aborted) {
        const change = plan.changes[nextIndex++];
        if (!change) return;
        if (!await checkpoint(state => { const entry = state.entries.find(e => e.path === change.path)!; entry.execution = 'applying'; })) return;
        // Workers waiting for the serial journal checkpoint must also honor cancellation.
        if (halted || options.signal?.aborted) return;
        let item: ExecutionItem;
        try {
          await this.types.verifyBaseline(plan.typePatch?.configAfterContent ?? plan.typeBaseline);
          const written = await this.vault.processText(change.path, current => {
            if (current !== change.beforeContent || exclusionFingerprint(this.getSettings()) !== plan.settingsFingerprint || shouldExclude(change.path, this.getSettings())) throw new OperationError('file-stale', change.path);
            return change.afterContent;
          });
          if (written !== change.afterContent) throw new OperationError('write-failed');
          item = { path: change.path, status: 'applied', reason: 'applied' };
        } catch (error) {
          const code = issueCode(error, 'write-failed');
          if (code === 'file-stale' || code === 'type-config-stale') item = { path: change.path, status: 'stale', reason: code };
          else {
            // A throwing write may already have committed. Never send it straight to retry.
            try {
              const current = await this.vault.readText(change.path);
              item = current === change.beforeContent ? { path: change.path, status: 'failed', reason: code } : { path: change.path, status: 'uncertain', reason: 'uncertain' };
            } catch { item = { path: change.path, status: 'uncertain', reason: 'uncertain' }; }
          }
        }
        items.set(change.path, item);
        if (item.status === 'uncertain') halted = true;
        if (!await checkpoint(state => {
          const entry = state.entries.find(e => e.path === change.path)!;
          entry.execution = item.status === 'skipped' ? 'not-run' : item.status; entry.reason = item.reason;
        })) items.set(change.path, { path: change.path, status: 'uncertain', reason: 'journal-unavailable' });
        done++;
        reportProgress({ done, total: plan.changes.length, currentPath: change.path,
          applied: [...items.values()].filter(item => item.status === 'applied').length,
          failed: [...items.values()].filter(item => item.status === 'failed').length });
      }
    });
    await Promise.all(workers);
    const finalSaved = await checkpoint(state => {
      for (const entry of state.entries) {
        const item = items.get(entry.path)!;
        entry.execution = item.status === 'skipped' ? 'not-run' : item.status; entry.reason = item.reason;
      }
      if (state.typeExecution === 'pending') state.typeExecution = 'not-run';
      state.execution = halted ? 'interrupted' : [...items.values()].every(item => item.status === 'applied') && !options.signal?.aborted ? 'completed' : 'partial';
    });
    if (!finalSaved) {
      for (const [path, item] of items) if (item.status === 'applied') items.set(path, { path, status: 'uncertain', reason: 'journal-unavailable' });
    }
    this.journal.release(id);
    return { transactionId: id, items: [...items.values(), ...plan.skipped.map(item => ({ ...item, status: 'skipped' as const }))],
      cancelled: Boolean(options.signal?.aborted), durationMs: Date.now() - startedAt, typeStatus,
      requiresReconciliation: !finalSaved || halted && (typeStatus === 'uncertain' || [...items.values()].some(item => item.status === 'uncertain')) };
  }
}
