import { describe, expect, it, vi } from 'vitest';
import { planRenameTag } from '../src/domain/plan';
import { sha256Hex } from '../src/infrastructure/hash';
import { batchServices, changePlan } from './support/vault';

describe('safe undo', () => {
  it('does not touch cancelled files that were never written', async () => {
    const { vault, executor, journal, undo } = batchServices();
    const changes = ['a.md', 'b.md'].map(path => {
      vault.add(path, {}, '#old');
      return planRenameTag(vault.meta(path), '#old', '#new')!;
    });
    const controller = new AbortController();
    const result = await executor.execute(changePlan(changes), {
      signal: controller.signal, onProgress: () => controller.abort(),
    });
    expect(result.succeeded).toEqual(['a.md']);
    expect(result.skipped).toEqual(['b.md']);
    expect(await journal.get(result.transactionId)).toMatchObject({
      entries: [{ state: 'applied' }, { state: 'not-applied' }],
    });
    vault.add('b.md', {}, 'User edit after cancellation');
    const current = await vault.readText('b.md');
    const progress = vi.fn();
    const resultUndo = await undo.undo(result.transactionId, { onProgress: progress });
    expect(resultUndo).toEqual({ restored: ['a.md'], skipped: [] });
    expect(await vault.readText('b.md')).toBe(current);
    expect(progress).toHaveBeenLastCalledWith(2, 2);
    expect((await journal.get(result.transactionId))!.status).toBe('rolled-back');
  });

  it('does not restore a file rejected because it changed before execution', async () => {
    const { vault, executor, journal, undo } = batchServices();
    vault.add('a.md', {}, '#old');
    const change = planRenameTag(vault.meta('a.md'), '#old', '#new')!;
    const begin = journal.begin.bind(journal);
    vi.spyOn(journal, 'begin').mockImplementationOnce(async (...args) => {
      const transaction = await begin(...args);
      vault.add('a.md', {}, 'User edit before write');
      return transaction;
    });
    const result = await executor.execute(changePlan([change]));
    expect(result.failed).toHaveLength(1);
    const current = await vault.readText('a.md');
    expect((await undo.undo(result.transactionId)).restored).toEqual([]);
    expect(await vault.readText('a.md')).toBe(current);
  });

  it.each([false, true])('preserves files without a recorded afterHash, force=%s', async force => {
    const { vault, storage, journal, undo } = batchServices();
    vault.add('a.md', {}, 'Current user content');
    const current = await vault.readText('a.md');
    await storage.save({
      transactionId: 'legacy', createdAt: 1, operation: { kind: 'deleteProperty', key: 'author' }, status: 'partial',
      entries: [{ path: 'a.md', beforeContent: 'Old content', beforeHash: await sha256Hex('Old content') }],
    });
    const result = await undo.undo('legacy', { force });
    expect(result.restored).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(await vault.readText('a.md')).toBe(current);
    expect((await journal.get('legacy'))!.status).toBe('partial');
  });

  it('can restore an older journal containing an afterHash but no entry state', async () => {
    const { vault, storage, undo } = batchServices();
    vault.add('a.md', {}, 'After');
    const after = await vault.readText('a.md');
    vault.add('a.md', {}, 'Before');
    const before = await vault.readText('a.md');
    vault.setText('a.md', after);
    await storage.save({
      transactionId: 'legacy', createdAt: 1, operation: { kind: 'deleteProperty', key: 'author' }, status: 'committed',
      entries: [{ path: 'a.md', beforeContent: before, beforeHash: await sha256Hex(before), afterHash: await sha256Hex(after) }],
    });
    expect((await undo.undo('legacy')).restored).toEqual(['a.md']);
    expect(await vault.readText('a.md')).toBe(before);
  });

  it('retries skipped files without overwriting files restored on the first attempt', async () => {
    const { vault, executor, journal, undo } = batchServices();
    const changes = ['a.md', 'b.md'].map(path => {
      vault.add(path, {}, '#old');
      return planRenameTag(vault.meta(path), '#old', '#new')!;
    });
    const result = await executor.execute(changePlan(changes));
    const afterB = await vault.readText('b.md');
    vault.add('b.md', {}, '#new with user edit');
    const progress = vi.fn();
    const first = await undo.undo(result.transactionId, { onProgress: progress });
    expect(first.restored).toEqual(['a.md']);
    expect(first.skipped).toEqual([{ path: 'b.md', reason: '外部已修改' }]);
    expect(progress).toHaveBeenLastCalledWith(2, 2);
    expect(await journal.get(result.transactionId)).toMatchObject({
      status: 'partial', entries: [{ state: 'restored' }, { state: 'applied' }],
    });
    vault.add('a.md', {}, 'New edit after first undo');
    const currentA = await vault.readText('a.md');
    vault.setText('b.md', afterB);
    expect(await undo.undo(result.transactionId)).toEqual({ restored: ['b.md'], skipped: [] });
    expect(await vault.readText('a.md')).toBe(currentA);
    expect((await journal.get(result.transactionId))!.status).toBe('rolled-back');
  });

  it('keeps failed restores retryable', async () => {
    const { vault, executor, journal, undo } = batchServices();
    vault.add('a.md', {}, '#old');
    const change = planRenameTag(vault.meta('a.md'), '#old', '#new')!;
    const result = await executor.execute(changePlan([change]));
    vi.spyOn(vault, 'processText').mockRejectedValueOnce(new Error('Locked file'));
    expect((await undo.undo(result.transactionId)).skipped).toHaveLength(1);
    expect((await journal.get(result.transactionId))!.status).toBe('partial');
    expect((await undo.undo(result.transactionId)).restored).toEqual(['a.md']);
    expect((await journal.get(result.transactionId))!.status).toBe('rolled-back');
  });

  it('does not overwrite an edit made between the undo check and the write', async () => {
    const { vault, executor, journal, undo } = batchServices();
    vault.add('a.md', {}, '#old');
    const change = planRenameTag(vault.meta('a.md'), '#old', '#new')!;
    const result = await executor.execute(changePlan([change]));
    const process = vault.processText.bind(vault);
    vi.spyOn(vault, 'processText').mockImplementationOnce(async (path, fn) => {
      vault.add(path, {}, 'Concurrent user edit');
      await process(path, fn);
    });
    expect((await undo.undo(result.transactionId)).skipped).toHaveLength(1);
    expect(await vault.readText('a.md')).toContain('Concurrent user edit');
    expect((await journal.get(result.transactionId))!.status).toBe('partial');
  });
});
