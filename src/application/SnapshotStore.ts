import type { VaultSnapshot } from '../domain/models';

export type IndexStatus = 'idle' | 'indexing' | 'ready' | 'stale';
export type SnapshotListener = (snapshot: VaultSnapshot | null) => void;

export class SnapshotStore {
  private snapshot: VaultSnapshot | null = null;
  private readonly listeners = new Set<SnapshotListener>();
  private state: IndexStatus = 'idle';

  get(): VaultSnapshot | null {
    return this.snapshot;
  }

  set(snapshot: VaultSnapshot): void {
    this.snapshot = snapshot;
    this.emit();
  }

  status(): IndexStatus {
    return this.state;
  }

  setStatus(status: IndexStatus): void {
    this.state = status;
    this.emit();
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch {
        // Listener errors must not break indexing.
      }
    }
  }
}
