import type { ChangeOperation } from '../../src/domain/models';
import type { ScopeQuery } from '../../src/domain/scope';
import { allNotesScope } from '../../src/domain/scope';
import { OperationError } from '../../src/domain/errors';
import type { BoundTagsResult, CachedMeta, VaultPort } from '../../src/ports/VaultPort';
import { ObsidianNoteCodec } from '../../src/infrastructure/ObsidianNoteCodec';
import { ObsidianTypeConfigCodec } from '../../src/infrastructure/ObsidianTypeConfigCodec';
import { ObsidianJournalStore } from '../../src/infrastructure/ObsidianJournalStore';
import { parseBodyTags } from '../../src/infrastructure/MarkdownTags';
import { ChangePlanner } from '../../src/application/ChangePlanner';
import { ChangeExecutor } from '../../src/application/ChangeExecutor';
import { JournalService } from '../../src/application/JournalService';
import { UndoService } from '../../src/application/UndoService';
import { TypeMigration } from '../../src/application/TypeMigration';
import { OperationCoordinator } from '../../src/application/OperationCoordinator';
import { SnapshotStore } from '../../src/application/SnapshotStore';
import { aggregateSnapshot } from '../../src/application/snapshot';
import { fileMeta } from '../../src/application/file-meta';
import { DEFAULT_SETTINGS } from '../../src/settings-model';

export class MemoryVault implements VaultPort {
  readonly files = new Map<string, { content: string; mtime: number }>();
  readonly config = new Map<string, string>();
  readonly unavailableTags = new Set<string>();
  readonly folders = new Set<string>();
  readonly codec = new ObsidianNoteCodec();
  noteWrites = 0;
  configWrites = 0;
  private clock = 0;
  private readonly markdownListeners = new Set<() => void>();
  add(path: string, frontmatter: Record<string, unknown> = {}, body = ''): void { this.setText(path, `---\n${JSON.stringify(frontmatter)}\n---\n${body}`); }
  setText(path: string, content: string): void {
    this.files.set(path, { content, mtime: ++this.clock });
    for (const listener of this.markdownListeners) listener();
    const parts = path.split('/'); parts.pop();
    for (let i = 1; i <= parts.length; i++) this.folders.add(parts.slice(0, i).join('/'));
  }
  frontmatter(path: string): Record<string, unknown> {
    const decoded = this.codec.decode(this.files.get(path)!.content);
    if (!decoded.ok) throw new Error('Invalid YAML');
    return decoded.note.frontmatter;
  }
  meta(path: string) { const meta = fileMeta(path, this.getMtime(path), this.getFileCache(path)); if (this.unavailableTags.has(path)) meta.tagsComplete = false; return meta; }
  getMarkdownFiles() { return [...this.files.keys()].map(path => ({ path })); }
  getFolders(): string[] { return [...this.folders].sort(); }
  getFileCache(path: string): CachedMeta | null {
    const file = this.files.get(path); if (!file) return null;
    const decoded = this.codec.decode(file.content);
    if (!decoded.ok) return { frontmatterParseError: true, bodyTags: [] };
    return { frontmatter: decoded.note.hasFrontmatter ? decoded.note.frontmatter : undefined, bodyTags: parseBodyTags(file.content, decoded.note.bodyStart) };
  }
  getMtime(path: string): number { return this.files.get(path)?.mtime ?? 0; }
  watchMarkdownChanges(listener: () => void): () => void { this.markdownListeners.add(listener); return () => { this.markdownListeners.delete(listener); }; }
  async readText(path: string): Promise<string> { const file = this.files.get(path); if (!file) throw new OperationError('file-missing', path); return file.content; }
  async readBoundTags(path: string, source: string): Promise<BoundTagsResult> {
    if (this.unavailableTags.has(path)) return { ok: false, code: 'metadata-stale' };
    const decoded = this.codec.decode(source);
    return decoded.ok ? { ok: true, bodyTags: parseBodyTags(source, decoded.note.bodyStart) } : decoded;
  }
  async processText(path: string, transform: (content: string) => string): Promise<string> {
    const current = this.files.get(path); if (!current) throw new OperationError('file-missing', path);
    const content = transform(current.content);
    this.setText(path, content); this.noteWrites++; return content;
  }
  getConfigDir(): string { return '.obsidian'; }
  async readConfigFile(path: string): Promise<string | null> { return this.config.get(path) ?? null; }
  async writeConfigFile(path: string, data: string): Promise<void> { this.config.set(path, data); this.configWrites++; }
  async processConfigFile(path: string, transform: (content: string) => string): Promise<string> {
    const current = this.config.get(path); if (current === undefined) throw new Error('Missing config');
    const content = transform(current); this.config.set(path, content); this.configWrites++; return content;
  }
  async listConfigDir(path: string): Promise<string[]> {
    const results = new Set<string>();
    for (const file of this.config.keys()) if (file.startsWith(`${path}/`)) results.add(`${path}/${file.slice(path.length + 1).split('/')[0]}`);
    return [...results];
  }
  async removeConfigFile(path: string): Promise<void> { this.config.delete(path); }
}
export function batchServices(concurrency = 1) {
  const vault = new MemoryVault(), settings = { ...structuredClone(DEFAULT_SETTINGS), writeConcurrency: concurrency };
  const store = new SnapshotStore(), storage = new ObsidianJournalStore(vault), codec = new ObsidianNoteCodec();
  const types = new TypeMigration(vault, new ObsidianTypeConfigCodec()), journal = new JournalService(storage, () => settings);
  const planner = new ChangePlanner(vault, store, () => settings, codec, types), executor = new ChangeExecutor(vault, journal, () => settings, types);
  const undo = new UndoService(vault, journal, types, codec, () => settings), coordinator = new OperationCoordinator(planner, executor, journal, undo);
  const snapshot = () => { const snapshot = aggregateSnapshot([...vault.files.keys()].map(path => vault.meta(path)), settings, 0, vault.getFolders()); store.set(snapshot); store.setStatus('ready'); return store.get()!; };
  const preview = (operation: ChangeOperation, scope: ScopeQuery = allNotesScope()) => { snapshot(); return planner.createPreview({ operation, scope }); };
  const prepare = async (operation: ChangeOperation, scope?: ScopeQuery) => { const view = await preview(operation, scope); return planner.getPrepared(view.id, view.revision); };
  const restore = async (id: string) => { const view = await undo.preview(id); return undo.recover(view.id, view.revision); };
  return { vault, settings, store, storage, codec, types, journal, planner, executor, undo, coordinator, snapshot, preview, prepare, restore };
}
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
export const renameTag: ChangeOperation = { kind: 'renameTag', from: '#old', to: '#new' };
