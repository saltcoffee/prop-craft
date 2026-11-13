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
    if (transaction.status === 'rolled-back') return { restored, skipped };
    let done = 0;
    for (const entry of transaction.entries) {
      try {
        if (entry.state === 'not-applied' || entry.state === 'restored') continue;
        if (!entry.afterHash) {
          skipped.push({ path: entry.path, reason: '缺少写入后的校验记录，未覆盖当前文件' });
          continue;
        }
        const current = await this.vault.readText(entry.path);
        const hash = await sha256Hex(current);
        if (hash === entry.beforeHash) {
          entry.state = 'restored';
          continue;
        }
        if (hash !== entry.afterHash && !options.force) {
          skipped.push({ path: entry.path, reason: '外部已修改' });
          continue;
        }
        await this.vault.processText(entry.path, content => {
          if (content !== current) throw new Error('外部已修改');
          return entry.beforeContent;
        });
        entry.state = 'restored';
        restored.push(entry.path);
      } catch (error) {
        skipped.push({ path: entry.path, reason: error instanceof Error ? error.message : String(error) });
      } finally {
        done += 1;
        options.onProgress?.(done, transaction.entries.length);
      }
    }
    await this.journal.finish(transaction, skipped.length > 0 ? 'partial' : 'rolled-back');
    return { restored, skipped };
  }
}
