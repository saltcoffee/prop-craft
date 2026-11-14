import type { FileMeta } from '../domain/models';
import type { VaultPort } from '../ports/VaultPort';
import type { NoteCodecPort } from '../ports/NoteCodecPort';
import type { PropCraftSettings } from '../settings-model';
import { fileMeta } from './file-meta';
import { aggregateSnapshot } from './snapshot';
import { shouldExclude } from './exclude';
import type { SnapshotStore } from './SnapshotStore';
export { emptySnapshot } from './snapshot';
export interface IndexerOptions {
  getSettings: () => PropCraftSettings;
  getTypes: () => Map<string, string>;
}
export class VaultIndexer {
  private stopped = false;
  private running = false;
  private pending = false;
  private readonly dirty = new Set<string>();
  private readonly versions = new Map<string, number>();
  private files = new Map<string, FileMeta>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly vault: VaultPort, private readonly store: SnapshotStore, private readonly options: IndexerOptions, private readonly codec: NoteCodecPort) {}
  start(): void { this.stopped = false; void this.rebuild(); }
  stop(): void { this.stopped = true; clearTimeout(this.timer); }
  async rebuild(): Promise<void> {
    if (this.stopped) return;
    if (this.running) { this.pending = true; return; }
    this.running = true; this.store.setStatus('indexing');
    try {
      const next = new Map<string, FileMeta>();
      const paths = this.vault.getMarkdownFiles().map(file => file.path);
      for (let i = 0; i < paths.length && !this.stopped; i += 32) {
        const metas = await Promise.all(paths.slice(i, i + 32).map(path => this.read(path)));
        for (const meta of metas) next.set(meta.path, meta);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      // Replay changes received during scanning before publishing the new snapshot.
      while (this.dirty.size && !this.stopped) {
        const dirty = [...this.dirty]; this.dirty.clear();
        const existing = new Set(this.vault.getMarkdownFiles().map(file => file.path));
        for (const path of dirty) {
          if (existing.has(path)) next.set(path, await this.read(path)); else next.delete(path);
        }
      }
      if (this.stopped) return;
      this.files = next; this.publish(); this.store.setStatus('ready');
    } catch { if (!this.stopped) this.store.setStatus('stale'); }
    finally {
      this.running = false;
      if (this.pending && !this.stopped) { this.pending = false; void this.rebuild(); }
    }
  }
  private async read(path: string): Promise<FileMeta> {
    try {
      const source = await this.vault.readText(path), decoded = this.codec.decode(source);
      if (!decoded.ok) return fileMeta(path, this.vault.getMtime(path), { frontmatterParseError: true, bodyTags: [] });
      const tags = await this.vault.readBoundTags(path, source);
      const meta = fileMeta(path, this.vault.getMtime(path), { frontmatter: decoded.note.hasFrontmatter ? decoded.note.frontmatter : undefined, bodyTags: tags.ok ? tags.bodyTags : [] }, this.options.getTypes());
      meta.rawFrontmatter = decoded.note.frontmatter;
      meta.tagsComplete = tags.ok && meta.tagsComplete;
      return meta;
    } catch { return fileMeta(path, this.vault.getMtime(path), null); }
  }
  onChanged(path: string): void { void this.update(path); }
  onCreated(path: string): void { void this.update(path); }
  onDeleted(path: string): void {
    this.versions.set(path, (this.versions.get(path) ?? 0) + 1);
    if (this.running) this.dirty.add(path);
    else { this.files = new Map(this.files); this.files.delete(path); this.schedule(); }
  }
  onRenamed(oldPath: string, newPath: string): void { this.onDeleted(oldPath); this.onCreated(newPath); }
  private async update(path: string): Promise<void> {
    if (this.stopped || !path.toLowerCase().endsWith('.md')) return;
    if (this.running) { this.dirty.add(path); return; }
    const version = (this.versions.get(path) ?? 0) + 1; this.versions.set(path, version);
    const meta = await this.read(path);
    if (this.stopped || version !== this.versions.get(path)) return;
    if (this.running) { this.dirty.add(path); return; }
    this.files = new Map(this.files).set(path, meta); this.schedule();
  }
  private schedule(): void { clearTimeout(this.timer); this.timer = setTimeout(() => this.publish(), 200); }
  private publish(): void {
    if (this.stopped) return;
    const settings = this.options.getSettings();
    const snapshot = aggregateSnapshot([...this.files.values()].filter(file => !shouldExclude(file.path, settings)), settings, 0, this.vault.getFolders());
    snapshot.files = new Map(this.files);
    this.store.set(snapshot);
  }
}
