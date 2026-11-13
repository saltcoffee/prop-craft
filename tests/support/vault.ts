import type { ChangePlan, FileChange, JournalMeta, JournalTransaction } from '../../src/domain/models';
import type { JournalStore } from '../../src/application/JournalService';
import { JournalService } from '../../src/application/JournalService';
import { ChangeExecutor } from '../../src/application/ChangeExecutor';
import { UndoService } from '../../src/application/UndoService';
import { extractFileMeta } from '../../src/application/VaultIndexer';
import type { CachedMeta, VaultPort } from '../../src/ports/VaultPort';
import { DEFAULT_SETTINGS } from '../../src/settings-model';

export class MemoryVault implements VaultPort {
  readonly files = new Map<string, { content: string; mtime: number }>();
  readonly config = new Map<string, string>();
  private clock = 0;

  add(path: string, frontmatter: Record<string, unknown> = {}, body = ''): void {
    this.setText(path, `---\n${JSON.stringify(frontmatter)}\n---\n${body}`);
  }

  setText(path: string, content: string): void {
    this.files.set(path, { content, mtime: ++this.clock });
  }

  setFrontmatter(path: string, frontmatter: Record<string, unknown>): void {
    const { body } = this.parts(path);
    this.add(path, frontmatter, body);
  }

  frontmatter(path: string): Record<string, unknown> {
    return this.parts(path).frontmatter;
  }

  meta(path: string) {
    return extractFileMeta(this, path, new Map());
  }

  private parts(path: string) {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing file: ${path}`);
    const end = file.content.indexOf('\n---\n', 4);
    return {
      frontmatter: JSON.parse(file.content.slice(4, end)) as Record<string, unknown>,
      body: file.content.slice(end + 5),
      bodyOffset: end + 5,
    };
  }

  getMarkdownFiles() {
    return [...this.files.keys()].map(path => ({ path }));
  }

  getFileCache(path: string): CachedMeta | null {
    if (!this.files.has(path)) return null;
    const { frontmatter, body, bodyOffset } = this.parts(path);
    return {
      frontmatter,
      bodyTags: [...body.matchAll(/#[^\s#]+/g)].map(match => ({
        tag: match[0], start: bodyOffset + match.index, end: bodyOffset + match.index + match[0].length,
      })),
    };
  }

  getMtime(path: string): number {
    return this.files.get(path)?.mtime ?? 0;
  }

  async readText(path: string): Promise<string> {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing file: ${path}`);
    return file.content;
  }

  async processText(path: string, fn: (content: string) => string): Promise<void> {
    const current = await this.readText(path);
    this.setText(path, fn(current));
  }

  async processFrontMatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void> {
    const fm = this.frontmatter(path);
    fn(fm);
    this.setFrontmatter(path, fm);
  }

  getConfigDir(): string {
    return '.obsidian';
  }

  async readConfigFile(path: string): Promise<string | null> {
    return this.config.get(path) ?? null;
  }

  async writeConfigFile(path: string, data: string): Promise<void> {
    this.config.set(path, data);
  }

  async listConfigDir(path: string): Promise<string[]> {
    return [...this.config.keys()].filter(file => file.startsWith(`${path}/`));
  }

  async removeConfigFile(path: string): Promise<void> {
    this.config.delete(path);
  }
}

export class MemoryJournalStore implements JournalStore {
  readonly transactions = new Map<string, JournalTransaction>();

  async save(transaction: JournalTransaction): Promise<void> {
    this.transactions.set(transaction.transactionId, structuredClone(transaction));
  }

  async load(id: string): Promise<JournalTransaction | null> {
    return structuredClone(this.transactions.get(id) ?? null);
  }

  async list(): Promise<JournalMeta[]> {
    return [...this.transactions.values()].map(transaction => ({
      transactionId: transaction.transactionId,
      createdAt: transaction.createdAt,
      operation: transaction.operation,
      status: transaction.status,
      fileCount: transaction.entries.length,
    }));
  }

  async remove(id: string): Promise<void> {
    this.transactions.delete(id);
  }
}

export function changePlan(changes: FileChange[]): ChangePlan {
  return {
    id: 'test-plan', createdAt: 0,
    operation: { kind: 'renameTag', from: '#old', to: '#new' },
    fileChanges: changes,
    summary: { totalFiles: changes.length, willChange: changes.length, willSkip: 0, conflicts: 0, byType: {} },
  };
}

export function batchServices() {
  const vault = new MemoryVault();
  const storage = new MemoryJournalStore();
  const settings = () => ({ ...DEFAULT_SETTINGS, writeConcurrency: 1 });
  const journal = new JournalService(storage, settings);
  return { vault, storage, journal, executor: new ChangeExecutor(vault, journal, settings), undo: new UndoService(vault, journal) };
}
