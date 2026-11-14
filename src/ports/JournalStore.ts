import type { JournalStateV2, JournalTransactionV2, LoadedJournal } from '../domain/journal';
export interface StoredJournal { id: string; loaded: LoadedJournal; bytes: number; reservedBytes: number }
export interface JournalStore {
  prepare(transaction: JournalTransactionV2, state: JournalStateV2): Promise<void>;
  checkpoint(id: string, expectedRevision: number, next: JournalStateV2): Promise<void>;
  initializeState(id: string, next: JournalStateV2): Promise<void>;
  load(id: string): Promise<LoadedJournal>;
  list(): Promise<StoredJournal[]>;
  removeOne(id: string): Promise<void>;
}
