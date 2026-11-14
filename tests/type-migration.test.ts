import { describe, expect, it, vi } from 'vitest';
import { batchServices } from './support/vault';
import { isTypeCompatible } from '../src/domain/type-config';
const operation = { kind: 'renameProperty' as const, from: 'Source', to: 'Target' };
describe('0.1.2 property type patches', () => {
  it('TC-R03: copies a missing target declaration, retains source and unrelated data, then restores by key', async () => {
    const s = batchServices(); s.vault.add('Books/A.md', { Source: ['Alice'] }); s.vault.add('Projects/L.md', { Source: ['Bob'] });
    s.vault.config.set('types.json', JSON.stringify({ types: { source: 'multitext' }, extra: { keep: true } }));
    const scope = { base: { kind: 'folder' as const, path: 'Books', includeSubfolders: true }, conditions: [], manuallyExcludedPaths: [] };
    const view = await s.preview(operation, scope); expect(view.typeSummary).toMatchObject({ kind: 'add', type: 'multitext' });
    const result = await s.executor.execute(s.planner.getPrepared(view.id, view.revision));
    expect(JSON.parse(s.vault.config.get('types.json')!)).toEqual({ types: { source: 'multitext', target: 'multitext' }, extra: { keep: true } });
    expect(s.vault.frontmatter('Projects/L.md')).toEqual({ Source: ['Bob'] });
    s.vault.config.set('types.json', JSON.stringify({ types: { source: 'multitext', target: 'multitext', year: 'number' }, extra: { keep: true } }));
    expect((await s.restore(result.transactionId)).complete).toBe(true);
    expect(JSON.parse(s.vault.config.get('types.json')!)).toEqual({ types: { source: 'multitext', year: 'number' }, extra: { keep: true } });
  });
  it('TC-R03: leaves an existing target type in place and blocks incompatible values', async () => {
    const s = batchServices(); s.vault.add('a.md', { Source: 'Alice' }); s.vault.config.set('types.json', '{"types":{"source":"text","target":"multitext"}}');
    const view = await s.preview(operation); expect(view.summary.blocked).toBe(1); expect(view.items[0].reason).toBe('type-incompatible'); expect(view.typeSummary.kind).toBe('existing');
    expect(() => s.planner.getPrepared(view.id, view.revision)).toThrow('plan-invalid'); expect(s.vault.noteWrites).toBe(0);
  });
  it('TC-R03: preserves a target declaration needed by a newly added or excluded note', async () => {
    const s = batchServices(); s.vault.add('a.md', { Source: ['Alice'] }); s.vault.config.set('types.json', '{"types":{"source":"multitext"}}');
    const result = await s.executor.execute(await s.prepare(operation)); s.vault.add('Excluded/New.md', { Target: ['New'] }); s.settings.excludeGlobs = ['Excluded/**'];
    const recovery = await s.restore(result.transactionId);
    expect(recovery.complete).toBe(false); expect(recovery.typeReason).toBe('type-in-use'); expect(JSON.parse(s.vault.config.get('types.json')!).types.target).toBe('multitext');
    expect(s.vault.frontmatter('a.md')).toEqual({ Source: ['Alice'] });
  });
  it.each(['scan', 'checkpoint', 'commit'])('TC-R03: preserves the target when dependencies change during %s', async stage => {
    const s = batchServices(); s.vault.add('a.md', { Source: ['Alice'] }); s.vault.add('Other.md', { other: true });
    s.vault.config.set('types.json', '{"types":{"source":"multitext"}}');
    const result = await s.executor.execute(await s.prepare(operation)), preview = await s.undo.preview(result.transactionId);
    expect(preview.type.kind).toBe('restore');
    if (stage === 'scan') {
      const read = s.vault.readText.bind(s.vault);
      vi.spyOn(s.vault, 'readText').mockImplementation(async path => {
        const content = await read(path);
        if (path === 'Other.md') s.vault.add('New.md', { Target: ['New'] });
        return content;
      });
    } else if (stage === 'checkpoint') {
      const checkpoint = s.storage.checkpoint.bind(s.storage);
      vi.spyOn(s.storage, 'checkpoint').mockImplementation((id, revision, state) => {
        if (state.typeRecovery === 'restoring') s.vault.add('New.md', { Target: ['New'] });
        return checkpoint(id, revision, state);
      });
    } else {
      const process = s.vault.processConfigFile.bind(s.vault);
      vi.spyOn(s.vault, 'processConfigFile').mockImplementation((path, transform) => {
        if (path === 'types.json') {
          const mtime = s.vault.getMtime('Other.md');
          s.vault.add('Other.md', { Target: ['New'] }); s.vault.files.get('Other.md')!.mtime = mtime;
        }
        return process(path, transform);
      });
    }
    const recovery = await s.undo.recover(preview.id, preview.revision);
    expect(recovery).toMatchObject({ complete: false, typeReason: 'type-in-use' });
    expect(JSON.parse(s.vault.config.get('types.json')!).types.target).toBe('multitext');
    expect(s.vault.frontmatter('a.md')).toEqual({ Source: ['Alice'] });
  });
  it('TC-R03: protects an externally changed target declaration during recovery', async () => {
    const s = batchServices(); s.vault.add('a.md', { Source: ['Alice'] }); s.vault.config.set('types.json', '{"types":{"source":"multitext"}}');
    const result = await s.executor.execute(await s.prepare(operation)); s.vault.config.set('types.json', '{"types":{"source":"multitext","target":"text"}}');
    expect((await s.restore(result.transactionId)).complete).toBe(false); expect(JSON.parse(s.vault.config.get('types.json')!).types.target).toBe('text');
  });
  it('TC-R03: a changed configuration baseline prevents note writes', async () => {
    const s = batchServices(); s.vault.add('a.md', { Source: ['Alice'] }); s.vault.config.set('types.json', '{"types":{"source":"multitext"}}');
    const plan = await s.prepare(operation); const changed = '{"types":{"source":"multitext","year":"number"}}'; s.vault.config.set('types.json', changed);
    const result = await s.executor.execute(plan); expect(result.typeStatus).toBe('stale'); expect(s.vault.noteWrites).toBe(0); expect(s.vault.config.get('types.json')).toBe(changed);
  });
  it('TC-R03: type-only changes after cancellation remain recoverable', async () => {
    const s = batchServices(); s.vault.add('a.md', { Source: ['Alice'] }); s.vault.config.set('types.json', '{"types":{"source":"multitext"}}');
    const plan = await s.prepare(operation), controller = new AbortController(), apply = s.types.apply.bind(s.types);
    vi.spyOn(s.types, 'apply').mockImplementationOnce(async patch => { await apply(patch); controller.abort(); });
    const result = await s.executor.execute(plan, { signal: controller.signal }); expect(s.vault.noteWrites).toBe(0); expect(result.typeStatus).toBe('applied');
    expect((await s.restore(result.transactionId)).complete).toBe(true); expect(JSON.parse(s.vault.config.get('types.json')!).types.target).toBeUndefined();
  });
  it('TC-R02/R03: type recovery does not reinterpret uncertain execution as not run', async () => {
    const s = batchServices(); s.vault.add('a.md', { Source: ['Alice'] });
    s.vault.config.set('types.json', '{"types":{"source":"multitext"}}');
    const plan = await s.prepare(operation), tx = await s.journal.prepare(plan);
    await s.journal.update(tx.transactionId, state => { state.typeExecution = 'uncertain'; state.typeRecovery = 'restoring'; state.recovery = 'partial'; });
    await s.undo.reconcile(tx.transactionId);
    expect(await s.journal.get(tx.transactionId)).toMatchObject({ kind: 'v2', state: { typeExecution: 'uncertain', typeRecovery: 'restored' } });
  });
  it('TC-R03: a type write that throws after commit is uncertain and prevents notes', async () => {
    const s = batchServices(); s.vault.add('a.md', { Source: ['Alice'] }); s.vault.config.set('types.json', '{"types":{"source":"multitext"}}');
    const plan = await s.prepare(operation), process = s.vault.processConfigFile.bind(s.vault);
    vi.spyOn(s.vault, 'processConfigFile').mockImplementation(async (path, fn) => { const result = await process(path, fn); if (path === 'types.json') throw Error('After type write'); return result; });
    const result = await s.executor.execute(plan); expect(result.typeStatus).toBe('uncertain'); expect(s.vault.noteWrites).toBe(0); expect(result.requiresReconciliation).toBe(true);
  });
  it.each(['null', '[]', '{}', '{"types":[]}', '{"types":{"source":42}}', 'bad JSON'])('TC-X06: rejects unknown type layouts: %s', async raw => {
    const s = batchServices(); s.vault.add('a.md', { Source: 'Alice' }); s.vault.config.set('types.json', raw);
    const view = await s.preview(operation); expect(view.typeSummary.kind).toBe('unsupported'); expect(view.summary.execute).toBe(0);
    expect(s.vault.config.get('types.json')).toBe(raw);
    const tag = await s.preview({ kind: 'renameTag', from: '#old', to: '#new' }); expect(tag.typeSummary.kind).toBe('none');
  });
  it.each([
    ['text', '5', true], ['text', 5, false], ['number', '5', false], ['number', 5, true], ['checkbox', true, true], ['checkbox', 'true', false],
    ['list', [], true], ['list', '', false], ['date', '2024-02-29', true], ['date', '2023-02-29', false], ['date', '01/02/2024', false],
    ['datetime', '2024-01-01T12:30', true], ['datetime', '2024-01-01T24:00', false], ['future', 'value', false], ['text', null, true],
  ])('checks type %s against %j without implicit conversions', (type, value, accepted) => { expect(isTypeCompatible(type as string, value)).toBe(accepted); });
  it('TC-R03: never removes a declaration reintroduced after its original recovery', async () => {
    const s = batchServices(); s.vault.add('a.md', { Source: ['Alice'] });
    s.vault.config.set('types.json', '{"types":{"source":"multitext"}}');
    const result = await s.executor.execute(await s.prepare(operation));
    expect((await s.restore(result.transactionId)).complete).toBe(true);
    const reintroduced = '{"types":{"source":"multitext","target":"multitext","year":"number"}}';
    s.vault.config.set('types.json', reintroduced);
    expect((await s.restore(result.transactionId)).complete).toBe(true);
    expect(s.vault.config.get('types.json')).toBe(reintroduced);
  });
  it('TC-R03: previews remaining target dependencies in the original note contents', async () => {
    const s = batchServices(); s.vault.add('a.md', { Source: ['Alice'], Target: ['Alice'] });
    s.vault.config.set('types.json', '{"types":{"source":"multitext"}}');
    const result = await s.executor.execute(await s.prepare(operation));
    const preview = await s.undo.preview(result.transactionId);
    expect(preview.type).toMatchObject({ kind: 'blocked', reason: 'type-in-use' });
  });

});
