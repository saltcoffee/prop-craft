export interface VaultFile {
  path: string;
}

export interface CachedTag {
  tag: string;
  /** Absolute character offsets of the tag in the file body. */
  start: number;
  end: number;
}

export interface CachedMeta {
  frontmatter?: Record<string, unknown>;
  frontmatterParseError?: boolean;
  /** Body (inline) tags only, with offsets. Frontmatter tags live in frontmatter. */
  bodyTags: CachedTag[];
}

export interface VaultPort {
  getMarkdownFiles(): VaultFile[];
  getFileCache(path: string): CachedMeta | null;
  getMtime(path: string): number;
  readText(path: string): Promise<string>;
  processFrontMatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void>;
  processText(path: string, fn: (content: string) => string): Promise<void>;
  getConfigDir(): string;
  readConfigFile(relPath: string): Promise<string | null>;
  writeConfigFile(relPath: string, data: string): Promise<void>;
  listConfigDir(relPath: string): Promise<string[]>;
  removeConfigFile(relPath: string): Promise<void>;
}
