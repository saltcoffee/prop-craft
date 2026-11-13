import type { ChangePlan, EditInstruction, ExecutionResult, FileChange, TextOp } from '../domain/models';
import { deepEqual } from '../domain/plan';
import { sha256Hex } from '../infrastructure/hash';
import type { VaultPort } from '../ports/VaultPort';
import type { PropCraftSettings } from '../settings-model';
import type { JournalService } from './JournalService';

export interface ExecuteOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, currentPath: string) => void;
  concurrency?: number;
}

function staleFile(path: string): Error {
  return new Error(`文件已在预览后修改，请重新预览：${path}`);
}

function applyTextOps(content: string, ops: TextOp[]): string {
  let output = content;
  for (const op of [...ops].sort((a, b) => b.start - a.start)) {
    if (output.slice(op.start, op.end) !== op.expect) throw new Error('标签位置已变化，请重新预览');
    output = output.slice(0, op.start) + op.replacement + output.slice(op.end);
  }
  return output;
}

function applyEdit(vault: VaultPort, change: FileChange, edit: EditInstruction, expectedContent: string): Promise<void> {
  const { path } = change;
  if (edit.target === 'content' && edit.textOps) {
    return vault.processText(path, content => {
      if (content !== expectedContent) throw staleFile(path);
      return applyTextOps(content, edit.textOps!);
    });
  }
  if (edit.target === 'frontmatter' && edit.fmOp) {
    return vault.processFrontMatter(path, fm => {
      const keys = new Set([...Object.keys(edit.fmOp?.set ?? {}), ...(edit.fmOp?.delete ?? [])]);
      for (const key of keys) {
        const before = change.beforeFrontmatter;
        if (Object.prototype.hasOwnProperty.call(fm, key) !== Object.prototype.hasOwnProperty.call(before, key)
          || !deepEqual(fm[key], before[key])) throw staleFile(path);
      }
      if (edit.fmOp?.set) Object.assign(fm, edit.fmOp.set);
      if (edit.fmOp?.delete) for (const key of edit.fmOp.delete) delete fm[key];
    });
  }
  return Promise.resolve();
}

export class ChangeExecutor {
  constructor(
    private readonly vault: VaultPort,
    private readonly journal: JournalService,
    private readonly getSettings: () => PropCraftSettings,
  ) {}

  async execute(plan: ChangePlan, options: ExecuteOptions = {}): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const concurrency = Math.max(1, options.concurrency ?? this.getSettings().writeConcurrency);
    const signal = options.signal;
    const changes = plan.fileChanges.filter(change => !change.skipped);

    const beforeContents = new Map<string, string>();
    const beforeHashes = new Map<string, string>();
    const succeeded: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    const processable: FileChange[] = [];
    // Pre-read originals. A single unreadable file must not abort the whole batch,
    // and unreadable files must never enter the journal (their original is unknown).
    for (const change of changes) {
      try {
        if (this.vault.getMtime(change.path) !== change.expectedMtime) throw staleFile(change.path);
        const content = await this.vault.readText(change.path);
        if (this.vault.getMtime(change.path) !== change.expectedMtime) throw staleFile(change.path);
        beforeContents.set(change.path, content);
        beforeHashes.set(change.path, await sha256Hex(content));
        processable.push(change);
      } catch (error) {
        failed.push({ path: change.path, error: error instanceof Error ? error.message : String(error) });
      }
    }

    const transaction = await this.journal.begin({ ...plan, fileChanges: processable }, beforeContents, beforeHashes);
    const queue = [...processable];
    let done = 0;

    const workers = Array.from({ length: concurrency }, async () => {
      for (;;) {
        if (signal?.aborted) return;
        const change = queue.shift();
        if (!change) return;
        try {
          await this.applyOne(change, beforeHashes.get(change.path) ?? '', transaction);
          succeeded.push(change.path);
        } catch (error) {
          failed.push({ path: change.path, error: error instanceof Error ? error.message : String(error) });
        }
        done += 1;
        options.onProgress?.(done, processable.length, change.path);
      }
    });
    await Promise.all(workers);
    for (const change of queue) this.journal.recordNotApplied(transaction, change.path);

    const cancelled = Boolean(signal?.aborted);
    const status: 'committed' | 'partial' = failed.length === 0 && !cancelled ? 'committed' : 'partial';
    await this.journal.finish(transaction, status);

    return {
      transactionId: transaction.transactionId,
      succeeded,
      failed,
      skipped: queue.map(change => change.path),
      cancelled,
      durationMs: Date.now() - startedAt,
    };
  }

  private async applyOne(
    change: FileChange,
    expectedHash: string,
    transaction: Parameters<JournalService['recordAfter']>[0],
  ): Promise<void> {
    let current: string;
    try {
      current = await this.vault.readText(change.path);
      if ((await sha256Hex(current)) !== expectedHash || this.vault.getMtime(change.path) !== change.expectedMtime) {
        throw staleFile(change.path);
      }
    } catch (error) {
      this.journal.recordNotApplied(transaction, change.path);
      throw error;
    }
    for (const edit of change.edits) {
      await applyEdit(this.vault, change, edit, current);
      current = await this.vault.readText(change.path);
      this.journal.recordAfter(transaction, change.path, await sha256Hex(current));
    }
  }
}
