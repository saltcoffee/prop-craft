import { describe, expect, it, vi } from 'vitest';
import { batchServices, deferred, renameTag } from './support/vault';
import type { ChangeOperation } from '../src/domain/models';

describe('0.1.2 protected execution', () => {
  it('TC-E02: writes combined body and frontmatter exactly once with prepared recovery evidence', async () => {
    const s = batchServices(); s.vault.add('a.md', { tags: ['old'], other: '[[Book]]' }, '#old');
    const before = await s.vault.readText('a.md'), plan = await s.prepare(renameTag);
    const result = await s.executor.execute(plan);
    expect(result.items).toEqual([{ path: 'a.md', status: 'applied', reason: 'applied' }]);
    expect(s.vault.noteWrites).toBe(1); expect(s.vault.frontmatter('a.md')).toEqual({ tags: ['new'], other: '[[Book]]' });
    expect(await s.vault.readText('a.md')).toContain('\n#new');
    expect(await s.journal.get(result.transactionId)).toMatchObject({ kind: 'v2', transaction: { entries: [{ beforeContent: before, expectedAfterHash: plan.changes[0].expectedAfterHash }] }, state: { execution: 'completed', entries: [{ execution: 'applied' }] } });
  });
  it.each(['before-click', 'inside-process'])('TC-E01: preserves same-mtime external edits at %s', async stage => {
    const s = batchServices(); s.vault.add('a.md', { from: 'Alice' }, 'Body');
    const plan = await s.prepare({ kind: 'renameProperty', from: 'from', to: 'to' });
    const mtime = s.vault.getMtime('a.md');
    const edit = () => { s.vault.add('a.md', { from: 'Alice' }, 'User edit'); s.vault.files.get('a.md')!.mtime = mtime; };
    if (stage === 'before-click') edit();
    else {
      const process = s.vault.processText.bind(s.vault);
      vi.spyOn(s.vault, 'processText').mockImplementationOnce((path, fn) => { edit(); return process(path, fn); });
    }
    const result = await s.executor.execute(plan);
    expect(result.items[0].status).toBe('stale'); expect(s.vault.noteWrites).toBe(0); expect(await s.vault.readText('a.md')).toContain('User edit');
  });
  it('TC-E01: checks files still waiting in the queue against preview content', async () => {
    const s = batchServices(); for (const p of ['a.md', 'b.md']) s.vault.add(p, {}, '#old');
    const plan = await s.prepare(renameTag);
    const result = await s.executor.execute(plan, { onProgress: p => { if (p.done === 1) s.vault.add('b.md', {}, 'New body #old'); } });
    expect(result.items.map(item => item.status)).toEqual(['applied', 'stale']); expect(s.vault.noteWrites).toBe(1);
  });
  it('TC-E04: cancellation finishes the active note and never dispatches new notes', async () => {
    const s = batchServices(), gate = deferred(), started = deferred();
    for (const p of ['a.md', 'b.md', 'c.md']) s.vault.add(p, {}, '#old');
    const plan = await s.prepare(renameTag), controller = new AbortController(), process = s.vault.processText.bind(s.vault);
    vi.spyOn(s.vault, 'processText').mockImplementationOnce(async (path, fn) => { started.resolve(); await gate.promise; return process(path, fn); });
    const pending = s.executor.execute(plan, { signal: controller.signal });
    await started.promise; controller.abort(); gate.resolve();
    const result = await pending;
    expect(result.items.map(item => item.status)).toEqual(['applied', 'not-run', 'not-run']); expect(result.cancelled).toBe(true); expect(s.vault.noteWrites).toBe(1);
  });
  it.each([1, 8])('TC-E03: durable checkpoints preserve every worker result at concurrency %s', async concurrency => {
    const s = batchServices(concurrency); for (let i = 0; i < 24; i++) s.vault.add(`${i}.md`, {}, '#old');
    const result = await s.executor.execute(await s.prepare(renameTag));
    expect(result.items.filter(item => item.status === 'applied')).toHaveLength(24);
    const loaded = await s.journal.get(result.transactionId);
    expect(loaded).toMatchObject({ kind: 'v2', state: { execution: 'completed', revision: 50 } });
    expect(s.vault.noteWrites).toBe(24);
    expect((await s.restore(result.transactionId)).complete).toBe(true);
  });
  it('TC-E06: prepare failure prevents all business writes', async () => {
    const s = batchServices(); s.vault.add('a.md', { source: ['x'] }); s.vault.config.set('types.json', '{"types":{"source":"multitext"}}');
    const plan = await s.prepare({ kind: 'renameProperty', from: 'source', to: 'target' }), before = s.vault.config.get('types.json');
    vi.spyOn(s.storage, 'prepare').mockRejectedValueOnce(Error('No disk'));
    await expect(s.executor.execute(plan)).rejects.toThrow('journal-unavailable');
    expect(s.vault.noteWrites).toBe(0); expect(s.vault.config.get('types.json')).toBe(before);
  });
  it('TC-E06/R02: failed initial state preparation can be confirmed original after restarting', async () => {
    const s = batchServices(); s.vault.add('a.md', { Source: ['Alice'] });
    s.vault.config.set('types.json', '{"types":{"source":"multitext"}}');
    await s.coordinator.initialize();
    const operation: ChangeOperation = { kind: 'renameProperty', from: 'Source', to: 'Target' }, view = await s.preview(operation);
    const write = s.vault.writeConfigFile.bind(s.vault); let failed = false;
    vi.spyOn(s.vault, 'writeConfigFile').mockImplementation((path, content) => {
      if (!failed && path.endsWith('/state.json')) { failed = true; return Promise.reject(Error('Transient failure')); }
      return write(path, content);
    });
    await expect(s.coordinator.apply(view.id, view.revision)).rejects.toThrow('journal-unavailable');
    expect(s.vault.noteWrites).toBe(0);
    const [record] = await s.journal.list(); await s.coordinator.initialize();
    expect(s.coordinator.getState().kind).toBe('recovery-required');
    await s.coordinator.reconcile(record.transactionId);
    const state = s.coordinator.getState();
    if (state.kind !== 'recovery-preview') throw Error('Expected recovery preview');
    expect(state.preview).toMatchObject({ canConfirmOriginal: true, type: { kind: 'original' }, items: [{ kind: 'original' }] });
    await s.coordinator.recover(state.preview.id, state.preview.revision);
    expect(s.coordinator.getState()).toMatchObject({ kind: 'recovery-result', result: { complete: true, requiresReconciliation: false } });
    expect((await s.journal.list())[0]).toMatchObject({ canRemove: true, needsReconciliation: false });
    expect(await s.journal.get(record.transactionId)).toMatchObject({ kind: 'v2', state: { entries: [{ execution: 'uncertain', recovery: 'restored' }] } });
    expect(s.vault.noteWrites).toBe(0); expect(s.vault.config.get('types.json')).toBe('{"types":{"source":"multitext"}}');
    const next = await s.preview(operation); await s.coordinator.apply(next.id, next.revision);
    expect(s.vault.noteWrites).toBe(1); expect(s.vault.frontmatter('a.md')).toEqual({ Target: ['Alice'] });
  });
  it('TC-E06: a failed readback verification prevents writes', async () => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old'); const plan = await s.prepare(renameTag);
    vi.spyOn(s.storage, 'load').mockResolvedValueOnce({ kind: 'invalid', transactionId: 'invalid', issue: 'journal-invalid' });
    await expect(s.executor.execute(plan)).rejects.toThrow('journal-invalid'); expect(s.vault.noteWrites).toBe(0);
  });
  it('TC-E06: checks count and UTF-8 capacity before writing, never prunes', async () => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old 中文'.repeat(100)); const plan = await s.prepare(renameTag);
    s.settings.journalMaxBytes = 10;
    await expect(s.executor.execute(plan)).rejects.toThrow('journal-capacity'); expect(s.vault.noteWrites).toBe(0);
    s.settings.journalMaxBytes = 1e7; s.settings.journalMaxTransactions = 1;
    const result = await s.executor.execute(plan); s.vault.add('b.md', {}, '#old');
    await expect(s.executor.execute(await s.prepare(renameTag))).rejects.toThrow('journal-capacity');
    expect((await s.journal.list()).map(meta => meta.transactionId)).toEqual([result.transactionId]);
  });
  it('TC-E03: distinguishes write-before-error from an ordinary failure', async () => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old');
    const plan = await s.prepare(renameTag), process = s.vault.processText.bind(s.vault);
    vi.spyOn(s.vault, 'processText').mockImplementationOnce(async (path, fn) => { await process(path, fn); throw Error('After write'); });
    const result = await s.executor.execute(plan);
    expect(result.items[0].status).toBe('uncertain'); expect(result.requiresReconciliation).toBe(true);
    expect(await s.vault.readText('a.md')).toContain('#new');
    await s.undo.reconcile(result.transactionId);
    expect(await s.journal.get(result.transactionId)).toMatchObject({ kind: 'v2', state: { execution: 'completed', entries: [{ execution: 'applied' }] } });
  });
  it('TC-E03: stops dispatching after an applied checkpoint fails', async () => {
    const s = batchServices(); for (const p of ['a.md', 'b.md']) s.vault.add(p, {}, '#old');
    const plan = await s.prepare(renameTag), checkpoint = s.storage.checkpoint.bind(s.storage);
    vi.spyOn(s.storage, 'checkpoint').mockImplementation((id, revision, state) => state.entries.some(e => e.execution === 'applied' || e.execution === 'uncertain') ? Promise.reject(Error('Checkpoint failed')) : checkpoint(id, revision, state));
    const result = await s.executor.execute(plan);
    expect(result.items.map(item => item.status)).toEqual(['uncertain', 'not-run']); expect(s.vault.noteWrites).toBe(1);
    expect(await s.journal.get(result.transactionId)).toMatchObject({ kind: 'v2', state: { entries: [{ execution: 'applying' }, { execution: 'pending' }] } });
  });
  it('TC-E04: coordinator acquires the instance lock before await and consumes plans once', async () => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old'); await s.coordinator.initialize();
    const view = await s.preview(renameTag), gate = deferred(), started = deferred(), process = s.vault.processText.bind(s.vault);
    vi.spyOn(s.vault, 'processText').mockImplementationOnce(async (path, fn) => { started.resolve(); await gate.promise; return process(path, fn); });
    const first = s.coordinator.apply(view.id, view.revision);
    await expect(s.coordinator.apply(view.id, view.revision)).rejects.toThrow('operation-busy');
    await started.promise; await expect(s.coordinator.previewRecovery('other')).rejects.toThrow('operation-busy'); gate.resolve(); await first;
    await expect(s.coordinator.apply(view.id, view.revision)).rejects.toThrow('plan-invalid'); expect(s.vault.noteWrites).toBe(1);
  });
  it('TC-E05: retries only failed and cancelled paths, excluding successful appends and new matches', async () => {
    const s = batchServices(); for (const p of ['a.md', 'b.md', 'c.md']) s.vault.add(p, { values: [1] });
    await s.coordinator.initialize();
    const operation: ChangeOperation = { kind: 'addProperty', key: 'values', value: [2], valueType: 'list', onConflict: 'append' };
    const plan = await s.prepare(operation), process = s.vault.processText.bind(s.vault), controller = new AbortController();
    vi.spyOn(s.vault, 'processText').mockImplementation((path, fn) => path === 'b.md' ? Promise.reject(Error('Locked')) : process(path, fn));
    const result = await s.executor.execute(plan, { signal: controller.signal, onProgress: p => { if (p.done === 2) controller.abort(); } });
    s.vault.add('d.md', { values: [1] });
    const retry = await s.coordinator.retry(result.transactionId);
    expect(retry.items.map(item => item.path)).toEqual(['b.md', 'c.md']); expect(retry.retryOf).toBe(result.transactionId);
    expect(s.vault.frontmatter('a.md').values).toEqual([1, 2]);
    vi.mocked(s.vault.processText).mockImplementation(process);
    const retried = await s.executor.execute(s.planner.getPrepared(retry.id, retry.revision));
    expect(retried.items.filter(item => item.status === 'applied')).toHaveLength(2); expect(s.vault.frontmatter('a.md').values).toEqual([1, 2]);
    expect(await s.journal.list()).toHaveLength(2);
  });
  it('TC-E04: view observers cannot abandon workers or release the shared task lock early', async () => {
    const s = batchServices(8); for (let i = 0; i < 12; i++) s.vault.add(`${i}.md`, {}, '#old');
    await s.coordinator.initialize();
    s.coordinator.subscribe(() => { throw Error('View was closed'); });
    const view = await s.preview(renameTag);
    await s.coordinator.apply(view.id, view.revision);
    expect(s.coordinator.getState().kind).toBe('result'); expect(s.vault.noteWrites).toBe(12);
    s.vault.add('extra.md', {}, '#old');
    const result = await s.executor.execute(await s.prepare(renameTag), { onProgress: () => { throw Error('Detached progress observer'); } });
    expect(result.items.filter(item => item.status === 'applied')).toHaveLength(1);
  });

});
