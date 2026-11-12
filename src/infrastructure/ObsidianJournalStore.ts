import type { JournalMeta, JournalTransaction } from '../domain/models';
import type { JournalStore } from '../application/JournalService';
import type { VaultPort } from '../ports/VaultPort';

const JOURNAL_DIR = 'plugins/propcraft/journal';

export class ObsidianJournalStore implements JournalStore {
  constructor(private readonly vault: VaultPort) {}

  private relative(transactionId: string): string {
    return `${JOURNAL_DIR}/${transactionId}.json`;
  }

  async save(transaction: JournalTransaction): Promise<void> {
    await this.vault.writeConfigFile(this.relative(transaction.transactionId), JSON.stringify(transaction));
  }

  async load(transactionId: string): Promise<JournalTransaction | null> {
    const raw = await this.vault.readConfigFile(this.relative(transactionId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as JournalTransaction;
    } catch {
      return null;
    }
  }

  async list(): Promise<JournalMeta[]> {
    const paths = await this.vault.listConfigDir(JOURNAL_DIR);
    const metas: JournalMeta[] = [];
    for (const path of paths) {
      if (!path.endsWith('.json')) continue;
      const name = path.split('/').pop();
      if (!name) continue;
      const raw = await this.vault.readConfigFile(`${JOURNAL_DIR}/${name}`);
      if (!raw) continue;
      try {
        const transaction = JSON.parse(raw) as JournalTransaction;
        metas.push({
          transactionId: transaction.transactionId,
          createdAt: transaction.createdAt,
          operation: transaction.operation,
          status: transaction.status,
          fileCount: transaction.entries.length,
          bytes: raw.length,
        });
      } catch {
        // Ignore unreadable journal files.
      }
    }
    return metas;
  }

  async remove(transactionId: string): Promise<void> {
    await this.vault.removeConfigFile(this.relative(transactionId));
  }
}
