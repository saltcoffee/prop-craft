import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../src/infrastructure/hash';
import { batchServices, renameTag } from './support/vault';

async function legacy(s: ReturnType<typeof batchServices>, afterHash = true, status = 'committed') {
  const before = 'Before', after = 'After'; s.vault.setText('a.md', after);
  const transaction = { transactionId: 'legacy', createdAt: 1, operation: { kind: 'deleteProperty', key: 'author' }, status,
    entries: [{ path: 'a.md', beforeContent: before, beforeHash: await sha256Hex(before), ...(afterHash ? { afterHash: await sha256Hex(after) } : {}) }] };
  s.vault.config.set('plugins/propcraft/journal/legacy.json', JSON.stringify(transaction));
  return transaction;
}
describe('0.1.2 conditional recovery', () => {
  it('TC-R01: restores only unchanged results and keeps partial recovery visible', async () => {
    const s = batchServices(); for (const path of ['a.md', 'b.md']) s.vault.add(path, {}, '#old');
    const before = await s.vault.readText('a.md'), result = await s.executor.execute(await s.prepare(renameTag));
    const afterB = await s.vault.readText('b.md'); s.vault.setText('b.md', 'User edit');
    const preview = await s.undo.preview(result.transactionId);
    expect(preview.items.map(item => item.kind)).toEqual(['restore', 'blocked']);
    const first = await s.undo.recover(preview.id, preview.revision);
    expect(first.complete).toBe(false); expect(await s.vault.readText('a.md')).toBe(before); expect(await s.vault.readText('b.md')).toBe('User edit');
    expect(await s.journal.get(result.transactionId)).toMatchObject({ kind: 'v2', state: { execution: 'completed', recovery: 'partial' } });
    s.vault.setText('a.md', 'A newer edit after recovery'); s.vault.setText('b.md', afterB);
    const second = await s.restore(result.transactionId);
    expect(second.complete).toBe(true); expect(await s.vault.readText('a.md')).toBe('A newer edit after recovery');
  });
  it('TC-R01: compares the full current string again inside the recovery callback', async () => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old'); const result = await s.executor.execute(await s.prepare(renameTag));
    const preview = await s.undo.preview(result.transactionId), process = s.vault.processText.bind(s.vault);
    vi.spyOn(s.vault, 'processText').mockImplementationOnce((path, fn) => { s.vault.setText(path, 'Concurrent edit'); return process(path, fn); });
    const recovery = await s.undo.recover(preview.id, preview.revision);
    expect(recovery.complete).toBe(false); expect(recovery.items[0].reason).toBe('external-edit'); expect(await s.vault.readText('a.md')).toBe('Concurrent edit');
  });
  it('TC-R01: recognizes already-original notes without redundant writes', async () => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old'); const before = await s.vault.readText('a.md');
    const result = await s.executor.execute(await s.prepare(renameTag)); s.vault.setText('a.md', before); const writes = s.vault.noteWrites;
    expect((await s.restore(result.transactionId)).items[0].kind).toBe('original'); expect(s.vault.noteWrites).toBe(writes);
  });
  it('TC-R02: a new coordinator only reports interrupted work; it never writes at startup', async () => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old'); const plan = await s.prepare(renameTag), tx = await s.journal.prepare(plan);
    await s.journal.update(tx.transactionId, state => { state.execution = 'running'; state.entries[0].execution = 'applying'; });
    s.vault.setText('a.md', plan.changes[0].afterContent);
    await s.coordinator.initialize(); expect(s.coordinator.getState().kind).toBe('recovery-required'); expect(s.vault.noteWrites).toBe(0);
    await s.coordinator.reconcile(tx.transactionId); expect(s.vault.noteWrites).toBe(0);
    expect(s.coordinator.getState()).toMatchObject({ kind: 'recovery-preview', preview: { items: [{ kind: 'restore' }] } });
  });
  it('TC-R02: expected contents without a durable applying checkpoint are never claimed', async () => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old'); const plan = await s.prepare(renameTag), tx = await s.journal.prepare(plan);
    s.vault.setText('a.md', plan.changes[0].afterContent);
    const preview = await s.undo.reconcile(tx.transactionId);
    expect(preview.items[0]).toMatchObject({ kind: 'not-applied' }); expect(s.vault.noteWrites).toBe(0);
  });
  it('TC-R02: state loss and corrupt state remain read only, while material stays visible', async () => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old'); const result = await s.executor.execute(await s.prepare(renameTag));
    s.vault.config.delete(`plugins/propcraft/journal/${result.transactionId}/state.json`);
    const preview = await s.undo.preview(result.transactionId);
    expect(preview.evidenceIssue).toBe('evidence-missing'); expect(preview.items[0].kind).toBe('blocked');
    await expect(s.undo.recover(preview.id, preview.revision)).rejects.toThrow('evidence-missing');
    expect((await s.journal.list())[0]).toMatchObject({ canRemove: false, needsReconciliation: true });
  });
  it.each(['note', 'type', 'state'])('TC-R02: original-state confirmation rechecks a changed %s', async changed => {
    const s = batchServices(); s.vault.add('a.md', { Source: ['Alice'] });
    s.vault.config.set('types.json', '{"types":{"source":"multitext"}}');
    const plan = await s.prepare({ kind: 'renameProperty', from: 'Source', to: 'Target' }), tx = await s.journal.prepare(plan);
    const path = `plugins/propcraft/journal/${tx.transactionId}/state.json`; s.vault.config.delete(path);
    const preview = await s.undo.preview(tx.transactionId); expect(preview.canConfirmOriginal).toBe(true);
    if (changed === 'note') s.vault.add('a.md', { Source: ['Alice'] }, 'New body');
    if (changed === 'type') s.vault.config.set('types.json', '{"types":{"source":"multitext","target":"multitext"}}');
    if (changed === 'state') s.vault.config.set(path, '{broken');
    const config = new Map(s.vault.config), content = await s.vault.readText('a.md');
    expect((await s.undo.preview(tx.transactionId)).canConfirmOriginal).toBe(false);
    await expect(s.undo.recover(preview.id, preview.revision)).rejects.toThrow(changed === 'note' ? 'external-edit' : changed === 'type' ? 'type-config-stale' : 'evidence-missing');
    expect(s.vault.noteWrites).toBe(0); expect(await s.vault.readText('a.md')).toBe(content); expect(s.vault.config).toEqual(config);
  });
  it('TC-R02: a restore committed before an error is reconciled as original without rewriting it', async () => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old'); const result = await s.executor.execute(await s.prepare(renameTag)), process = s.vault.processText.bind(s.vault);
    vi.spyOn(s.vault, 'processText').mockImplementationOnce(async (path, fn) => { await process(path, fn); throw Error('after restore'); });
    const first = await s.restore(result.transactionId); expect(first.complete).toBe(false); const writes = s.vault.noteWrites;
    await s.undo.reconcile(result.transactionId);
    expect(await s.journal.get(result.transactionId)).toMatchObject({ kind: 'v2', state: { execution: 'completed', entries: [{ execution: 'applied', recovery: 'restored' }] } });
    await s.restore(result.transactionId); expect(s.vault.noteWrites).toBe(writes);
  });
  it('TC-E05/R02: retry excludes applied notes after an interrupted recovery', async () => {
    const s = batchServices(); for (const path of ['a.md', 'b.md']) s.vault.add(path, { values: [1] });
    const process = s.vault.processText.bind(s.vault);
    vi.spyOn(s.vault, 'processText').mockImplementation((path, transform) => path === 'b.md' ? Promise.reject(Error('Locked')) : process(path, transform));
    const result = await s.executor.execute(await s.prepare({ kind: 'addProperty', key: 'values', value: [2], valueType: 'list', onConflict: 'append' }));
    vi.mocked(s.vault.processText).mockImplementationOnce(async (path, transform) => { await process(path, transform); throw Error('After restore'); });
    expect((await s.restore(result.transactionId)).complete).toBe(false);
    await s.undo.reconcile(result.transactionId); await s.coordinator.initialize();
    const retry = await s.coordinator.retry(result.transactionId);
    expect(retry.items.map(item => item.path)).toEqual(['b.md']);
    expect(s.vault.frontmatter('a.md').values).toEqual([1]);
  });
  it.each(['after', 'edited', 'unreadable'])('TC-R02: recovery reconciliation preserves applied execution for %s contents', async contents => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old');
    const result = await s.executor.execute(await s.prepare(renameTag));
    await s.journal.update(result.transactionId, state => { state.entries[0].recovery = 'restoring'; state.recovery = 'partial'; });
    if (contents === 'edited') s.vault.setText('a.md', 'External edit');
    if (contents === 'unreadable') vi.spyOn(s.vault, 'readText').mockRejectedValue(Error('Locked'));
    await s.undo.reconcile(result.transactionId);
    const recovery = contents === 'after' ? 'none' : contents === 'edited' ? 'blocked' : 'uncertain';
    expect(await s.journal.get(result.transactionId)).toMatchObject({ kind: 'v2', state: { execution: 'completed', entries: [{ execution: 'applied', recovery }] } });
  });
  it.each(['committed', 'rolled-back'])('TC-R04: safely restores legacy %s using hashes, preserving the V1 source', async status => {
    const s = batchServices(), transaction = await legacy(s, true, status), originalJSON = JSON.stringify(transaction);
    const preview = await s.undo.preview('legacy'); expect(preview.legacy).toBe(true); expect(preview.items[0].kind).toBe('restore');
    expect((await s.undo.recover(preview.id, preview.revision)).complete).toBe(true); expect(await s.vault.readText('a.md')).toBe('Before');
    expect(s.vault.config.get('plugins/propcraft/journal/legacy.json')).toBe(originalJSON);
  });
  it('TC-R04: missing legacy afterHash cannot authorize an overwrite', async () => {
    const s = batchServices(); await legacy(s, false); const preview = await s.undo.preview('legacy');
    expect(preview.items[0]).toMatchObject({ kind: 'blocked', reason: 'evidence-missing' });
    const result = await s.undo.recover(preview.id, preview.revision); expect(result.complete).toBe(false); expect(await s.vault.readText('a.md')).toBe('After'); expect(s.vault.noteWrites).toBe(0);
  });
  it.each(['{"schemaVersion":3}', '{bad', '{"entries":[]}'])('TC-X06: invalid or future records stay visible, read only: %s', async raw => {
    const s = batchServices(); s.vault.config.set('plugins/propcraft/journal/broken.json', raw);
    const metas = await s.journal.list(); expect(metas).toHaveLength(1); expect(metas[0].canRemove).toBe(false);
    await expect(s.undo.preview('broken')).rejects.toThrow(/journal-(unsupported|invalid)/);
    await expect(s.journal.removeOne('broken')).rejects.toThrow('recovery-required');
  });
  it('TC-X06: journal IDs and paths cannot escape the vault', async () => {
    const s = batchServices(); await expect(s.journal.get('../outside')).rejects.toThrow('journal-invalid');
    const transaction = await legacy(s); transaction.entries[0].path = '../outside.md';
    s.vault.config.set('plugins/propcraft/journal/legacy.json', JSON.stringify(transaction));
    expect(await s.journal.get('legacy')).toMatchObject({ kind: 'invalid' }); expect(s.vault.noteWrites).toBe(0);
  });
  it('TC-X06: only explicitly selected completed records may be cleaned', async () => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old'); const result = await s.executor.execute(await s.prepare(renameTag));
    await s.journal.removeOne(result.transactionId); expect(await s.journal.list()).toEqual([]);
    s.vault.add('b.md', {}, '#old'); const tx = await s.journal.prepare(await s.prepare(renameTag));
    await expect(s.journal.removeOne(tx.transactionId)).rejects.toThrow('recovery-required');
  });
  it('TC-R01: respects current global exclusions before and inside the restore callback', async () => {
    for (const inside of [false, true]) {
      const s = batchServices(); s.vault.add('a.md', {}, '#old');
      const result = await s.executor.execute(await s.prepare(renameTag));
      const current = await s.vault.readText('a.md'), preview = await s.undo.preview(result.transactionId);
      if (!inside) s.settings.excludeGlobs = ['a.md'];
      else {
        const process = s.vault.processText.bind(s.vault);
        vi.spyOn(s.vault, 'processText').mockImplementationOnce((path, transform) => {
          s.settings.excludeGlobs = ['a.md']; return process(path, transform);
        });
      }
      const recovered = await s.undo.recover(preview.id, preview.revision);
      expect(recovered.complete).toBe(false);
      expect(await s.vault.readText('a.md')).toBe(current);
      expect(s.vault.noteWrites).toBe(1);
    }
  });

  it('TC-E06/R02: protects cancelled records until their recovery state is confirmed', async () => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old');
    const controller = new AbortController(); controller.abort();
    const result = await s.executor.execute(await s.prepare(renameTag), { signal: controller.signal });
    expect((await s.journal.list())[0].canRemove).toBe(false);
    expect((await s.restore(result.transactionId)).complete).toBe(true);
    expect((await s.journal.list())[0].canRemove).toBe(true);
  });
  it('TC-R02: confirmed recovery resolves an interrupted write without rewriting its execution history', async () => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old');
    const plan = await s.prepare(renameTag), tx = await s.journal.prepare(plan);
    await s.journal.update(tx.transactionId, state => { state.execution = 'interrupted'; state.entries[0].execution = 'uncertain'; });
    s.vault.setText('a.md', plan.changes[0].afterContent);
    expect((await s.restore(tx.transactionId)).complete).toBe(true);
    const meta = (await s.journal.list())[0]; expect(meta.needsReconciliation).toBe(false); expect(meta.canRemove).toBe(true);
  });

  it('TC-X06: malformed journal filenames remain visible and consume capacity', async () => {
    const s = batchServices(), raw = '破损记录';
    s.vault.config.set('plugins/propcraft/journal/broken.record.json', raw);
    const meta = (await s.journal.list())[0];
    expect(meta).toMatchObject({ kind: 'invalid', canRemove: false, bytes: new TextEncoder().encode(raw).byteLength });
    s.settings.journalMaxTransactions = 1; s.vault.add('a.md', {}, '#old');
    await expect(s.executor.execute(await s.prepare(renameTag))).rejects.toThrow('journal-capacity');
    expect(s.vault.noteWrites).toBe(0);
  });

});
