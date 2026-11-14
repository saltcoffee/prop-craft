export interface VaultFile { path: string }
export interface CachedTag { tag: string; start: number; end: number }
export interface CachedMeta {
  frontmatter?: Record<string, unknown>;
  frontmatterParseError?: boolean;
  bodyTags: CachedTag[];
}
export type BoundTagsResult = { ok: true; bodyTags: CachedTag[] } | { ok: false; code: 'metadata-stale' | 'frontmatter-invalid' };
export interface VaultPort {
  getMarkdownFiles(): VaultFile[];
  getFolders(): string[];
  getMtime(path: string): number;
  watchMarkdownChanges(listener: () => void): () => void;
  readText(path: string): Promise<string>;
  processText(path: string, transform: (current: string) => string): Promise<string>;
  readBoundTags(path: string, source: string, signal?: AbortSignal): Promise<BoundTagsResult>;
  getConfigDir(): string;
  readConfigFile(relative: string): Promise<string | null>;
  writeConfigFile(relative: string, data: string): Promise<void>;
  processConfigFile(relative: string, transform: (current: string) => string): Promise<string>;
  listConfigDir(relative: string): Promise<string[]>;
  removeConfigFile(relative: string): Promise<void>;
}
