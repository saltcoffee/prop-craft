import { App, TFile, normalizePath } from 'obsidian';
import type { CachedMeta, CachedTag, VaultFile, VaultPort } from '../ports/VaultPort';

export class ObsidianVaultAdapter implements VaultPort {
  constructor(private readonly app: App) {}

  private file(path: string): TFile | null {
    const abstract = this.app.vault.getAbstractFileByPath(path);
    return abstract instanceof TFile ? abstract : null;
  }

  getMarkdownFiles(): VaultFile[] {
    return this.app.vault.getMarkdownFiles().map(file => ({ path: file.path }));
  }

  getFileCache(path: string): CachedMeta | null {
    const file = this.file(path);
    if (!file) return null;
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return null;
    const frontmatter = cache.frontmatter;
    const withPosition = cache as unknown as {
      frontmatterPosition?: { end?: { offset?: number } };
    };
    // cache.tags can include frontmatter tags whose positions sit inside the YAML block.
    // Exclude those so inline replacement never edits the frontmatter region.
    const frontmatterEnd = withPosition.frontmatterPosition?.end?.offset ?? -1;
    const bodyTags: CachedTag[] = (cache.tags ?? [])
      .filter(tag => tag.position)
      .filter(tag => tag.position.start.offset > frontmatterEnd)
      .map(tag => ({ tag: tag.tag, start: tag.position.start.offset, end: tag.position.end.offset }));
    return {
      frontmatter,
      frontmatterParseError: !frontmatter && Boolean(withPosition.frontmatterPosition),
      bodyTags,
    };
  }

  getMtime(path: string): number {
    return this.file(path)?.stat?.mtime ?? 0;
  }

  async readText(path: string): Promise<string> {
    const file = this.file(path);
    if (!file) throw new Error(`文件不存在：${path}`);
    return this.app.vault.read(file);
  }

  async processFrontMatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void> {
    const file = this.file(path);
    if (!file) throw new Error(`文件不存在：${path}`);
    await this.app.fileManager.processFrontMatter(file, fn);
  }

  async processText(path: string, fn: (content: string) => string): Promise<void> {
    const file = this.file(path);
    if (!file) throw new Error(`文件不存在：${path}`);
    await this.app.vault.process(file, fn);
  }

  getConfigDir(): string {
    return this.app.vault.configDir;
  }

  private configPath(relative: string): string {
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

  async listConfigDir(relative: string): Promise<string[]> {
    const path = this.configPath(relative);
    if (!(await this.app.vault.adapter.exists(path))) return [];
    const listing = await this.app.vault.adapter.list(path);
    return listing.files;
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
        await this.app.vault.adapter.mkdir(current).catch(() => undefined);
      }
    }
  }
}
