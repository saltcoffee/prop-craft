import { sha256Hex } from '../infrastructure/hash';
import type { VaultPort } from '../ports/VaultPort';
import type { JournalService } from './JournalService';

export interface UndoResult {
  restored: string[];
  skipped: Array<{ path: string; reason: string }>;
}

export interface UndoOptions {
  force?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export class UndoService {
  constructor(
    private readonly vault: VaultPort,
    private readonly journal: JournalService,
  ) {}

  async undo(transactionId: string, options: UndoOptions = {}): Promise<UndoResult> {
    const transaction = await this.journal.get(transactionId);
    if (!transaction) throw new Error('找不到撤销记录');
    const restored: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    let done = 0;
    for (const entry of transaction.entries) {
      try {
        const current = await this.vault.readText(entry.path);
        const hash = await sha256Hex(current);
        if (entry.afterHash && hash !== entry.afterHash && !options.force) {
          skipped.push({ path: entry.path, reason: '外部已修改' });
          continue;
        }
        await this.vault.processText(entry.path, () => entry.beforeContent);
        restored.push(entry.path);
      } catch (error) {
        skipped.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) });
      }
      done += 1;
      options.onProgress?.(done, transaction.entries.length);
    }
    await this.journal.finish(transaction, 'rolled-back');
    return { restored, skipped };
  }
}
