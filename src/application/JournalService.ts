import type { ChangePlan, JournalEntry, JournalMeta, JournalTransaction } from '../domain/models';
import type { PropCraftSettings } from '../settings-model';

export interface JournalStore {
  save(transaction: JournalTransaction): Promise<void>;
  load(transactionId: string): Promise<JournalTransaction | null>;
  list(): Promise<JournalMeta[]>;
  remove(transactionId: string): Promise<void>;
}

function newTransactionId(): string {
  return `tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export class JournalService {
  constructor(
    private readonly store: JournalStore,
    private readonly getSettings: () => PropCraftSettings,
  ) {}

  async begin(
    plan: ChangePlan,
    beforeContents: Map<string, string>,
    beforeHashes: Map<string, string>,
  ): Promise<JournalTransaction> {
    const entries: JournalEntry[] = plan.fileChanges.map(change => ({
      path: change.path,
      beforeHash: beforeHashes.get(change.path) ?? '',
      beforeContent: beforeContents.get(change.path) ?? '',
    }));
    const transaction: JournalTransaction = {
      transactionId: newTransactionId(),
      createdAt: Date.now(),
      operation: plan.operation,
      entries,
      status: 'in-progress',
    };
    await this.store.save(transaction);
    return transaction;
  }

  recordAfter(transaction: JournalTransaction, path: string, afterHash: string): void {
    const entry = transaction.entries.find(candidate => candidate.path === path);
    if (entry) entry.afterHash = afterHash;
  }

  async finish(transaction: JournalTransaction, status: JournalTransaction['status']): Promise<void> {
    transaction.status = status;
    await this.store.save(transaction);
    await this.prune();
  }

  async get(transactionId: string): Promise<JournalTransaction | null> {
    return this.store.load(transactionId);
  }

  async list(): Promise<JournalMeta[]> {
    const metas = await this.store.list();
    return metas.sort((a, b) => b.createdAt - a.createdAt);
  }

  async remove(transactionId: string): Promise<void> {
    await this.store.remove(transactionId);
  }

  private async prune(): Promise<void> {
    const settings = this.getSettings();
    const metas = (await this.store.list()).sort((a, b) => b.createdAt - a.createdAt);
    const keep = metas.slice(0, Math.max(0, settings.journalMaxTransactions));
    const drop = metas.slice(keep.length);
    let total = keep.reduce((sum, meta) => sum + (meta.bytes ?? 0), 0);
    while (keep.length > 0 && total > settings.journalMaxBytes) {
      const removed = keep.pop();
      if (!removed) break;
      total -= removed.bytes ?? 0;
      drop.push(removed);
    }
    for (const meta of drop) await this.store.remove(meta.transactionId);
  }
}
