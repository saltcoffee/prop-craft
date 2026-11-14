import { App, TFile, TFolder, normalizePath, type TAbstractFile } from 'obsidian';
import type { BoundTagsResult, VaultFile, VaultPort } from '../ports/VaultPort';

import { isNotePath, isVaultPath } from '../domain/scope';
import { OperationError } from '../domain/errors';
import { ObsidianNoteCodec } from './ObsidianNoteCodec';
import { parseBodyTags } from './MarkdownTags';

export class ObsidianVaultAdapter implements VaultPort {
  constructor(private readonly app: App) {}

  private file(path: string): TFile | null {
    if (!isNotePath(path)) throw new OperationError('input-invalid', path);
    const abstract = this.app.vault.getAbstractFileByPath(path);
    return abstract instanceof TFile ? abstract : null;
  }

  getMarkdownFiles(): VaultFile[] {
    return this.app.vault.getMarkdownFiles().map(file => ({ path: file.path }));
  }

  getFolders(): string[] {
    return this.app.vault.getAllLoadedFiles().filter(file => file instanceof TFolder && file.path !== '/').map(file => file.path).sort();
  }

  async readBoundTags(_path: string, source: string, signal?: AbortSignal): Promise<BoundTagsResult> {
    signal?.throwIfAborted();
    const decoded = new ObsidianNoteCodec().decode(source);
    if (!decoded.ok) return decoded;
    return { ok: true, bodyTags: parseBodyTags(source, decoded.note.bodyStart) };
  }

  getMtime(path: string): number {
    return this.file(path)?.stat?.mtime ?? 0;
  }

  watchMarkdownChanges(listener: () => void): () => void {
    const changed = (file: TAbstractFile, oldPath?: string) => {
      if (file instanceof TFolder || file instanceof TFile && file.extension.toLowerCase() === 'md' || oldPath?.toLowerCase().endsWith('.md')) listener();
    };
    const refs = [this.app.vault.on('create', changed), this.app.vault.on('modify', changed), this.app.vault.on('delete', changed), this.app.vault.on('rename', changed)];
    return () => { for (const ref of refs) this.app.vault.offref(ref); };
  }

  async readText(path: string): Promise<string> {
    const file = this.file(path);
    if (!file) throw new OperationError('file-missing', path);
    return this.app.vault.read(file);
  }

  async processText(path: string, fn: (content: string) => string): Promise<string> {
    const file = this.file(path);
    if (!file) throw new OperationError('file-missing', path);
    return this.app.vault.process(file, fn);
  }

  getConfigDir(): string {
    return this.app.vault.configDir;
  }

  private configPath(relative: string): string {
    if (!isVaultPath(relative) || relative !== 'types.json' && !relative.startsWith('plugins/propcraft/')) throw new OperationError('input-invalid');
    return normalizePath(`${this.app.vault.configDir}/${relative}`);
  }

  async readConfigFile(relative: string): Promise<string | null> {
    const path = this.configPath(relative);
    if (!(await this.app.vault.adapter.exists(path))) return null;
    return this.app.vault.adapter.read(path);
  }

  async writeConfigFile(relative: string, data: string): Promise<void> {
    const path = this.configPath(relative);
    await this.ensureDir(path);
    await this.app.vault.adapter.write(path, data);
  }

  async processConfigFile(relative: string, transform: (current: string) => string): Promise<string> {
    const path = this.configPath(relative);
    if (!(await this.app.vault.adapter.exists(path)) || typeof this.app.vault.adapter.process !== 'function') throw new OperationError('type-config-unsupported');
    return this.app.vault.adapter.process(path, transform);
  }

  async listConfigDir(relative: string): Promise<string[]> {
    const path = this.configPath(relative);
    if (!(await this.app.vault.adapter.exists(path))) return [];
    const listing = await this.app.vault.adapter.list(path);
    return [...listing.files, ...listing.folders].map(item => item.slice(this.app.vault.configDir.length + 1));
  }

  async removeConfigFile(relative: string): Promise<void> {
    const path = this.configPath(relative);
    if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.remove(path);
  }

  private async ensureDir(filePath: string): Promise<void> {
    const segments = filePath.split('/');
    segments.pop();
    let current = '';
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }
}
