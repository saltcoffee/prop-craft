import { describe, expect, it, vi } from 'vitest';
import { batchServices, deferred } from './support/vault';
import { seedFixtures } from './support/fixtures';
import type { ChangeOperation } from '../src/domain/models';
import type { ScopeQuery } from '../src/domain/scope';
const scope: ScopeQuery = { base: { kind: 'folder', path: 'Books', includeSubfolders: true }, conditions: [{ id: 'book', kind: 'tag', tag: '#book', operator: 'contains', includeDescendants: false }], manuallyExcludedPaths: [] };
describe('0.1.2 decision previews', () => {
  it('TC-P01: preserves 97 selected notes independently of display search and revisions', async () => {
    const s = batchServices(); for (let i = 0; i < 100; i++) s.vault.add(`${i}.md`);
    const view = await s.preview({ kind: 'addProperty', key: 'status', value: 'unread', valueType: 'text', onConflict: 'skip' });
    const revised = await s.planner.revisePreview(view.id, view.revision, view.items.slice(0, 3).map(item => ({ path: item.path, beforeHash: item.decision.beforeHash, selected: false })));
    expect(revised.summary).toMatchObject({ execute: 97, skip: 3, total: 100 });
    expect(revised.items.filter(item => item.path.includes('9')).length).toBeGreaterThan(0);
    const result = await s.executor.execute(s.planner.getPrepared(revised.id, revised.revision));
    expect(result.items.filter(item => item.status === 'applied')).toHaveLength(97); expect(result.items.filter(item => item.status === 'skipped')).toHaveLength(3); expect(s.vault.noteWrites).toBe(97);
  });
  it('TC-P02: handles missing targets, list unions and per-file destructive choices', async () => {
    const s = batchServices(); seedFixtures(s.vault); s.settings.excludeGlobs = ['Books/Templates/**'];
    const view = await s.preview({ kind: 'mergeProperty', from: '作者', to: 'author' }, scope);
    expect(view.summary).toMatchObject({ execute: 2, conflicts: 2, noop: 7 });
    const decisions = [['Books/A.md', 'skip'], ['Books/B.md', 'keep-target'], ['Books/C.md', 'merge-list'], ['Books/D.md', 'keep-source']] as const;
    const revised = await s.planner.revisePreview(view.id, view.revision, decisions.map(([path, merge]) => ({ path, beforeHash: view.items.find(item => item.path === path)!.decision.beforeHash, merge })));
    expect(revised.summary.execute).toBe(3);
    await s.executor.execute(s.planner.getPrepared(revised.id, revised.revision));
    expect(s.vault.frontmatter('Books/A.md')['作者']).toBe('甲'); expect(s.vault.frontmatter('Books/B.md').author).toBe('丙');
    expect(s.vault.frontmatter('Books/C.md').author).toEqual(['甲', '乙']); expect(s.vault.frontmatter('Books/D.md').author).toBe(7);
    for (const path of ['Books/B.md', 'Books/C.md', 'Books/D.md']) expect(Object.hasOwn(s.vault.frontmatter(path), '作者')).toBe(false);
  });
  it('TC-P02: rejects scalar list-union decisions and renaming onto a scalar conflict', async () => {
    const s = batchServices(); s.vault.add('a.md', { from: 'source', to: 'target' });
    const view = await s.preview({ kind: 'renameProperty', from: 'from', to: 'to' }); expect(view.summary.execute).toBe(0);
    await expect(s.planner.revisePreview(view.id, view.revision, [{ path: 'a.md', beforeHash: view.items[0].decision.beforeHash, merge: 'merge-list' }])).rejects.toThrow('invalid-decision');
    expect(() => s.planner.getPrepared(view.id, view.revision)).toThrow('plan-invalid'); expect(s.vault.noteWrites).toBe(0);
  });
  it('TC-P04: requires explicit confirmation for ambiguous regional dates', async () => {
    const s = batchServices(); s.vault.add('a.md', { date: '01/02/2024' }); s.vault.add('b.md', { date: '2024-01-02' });
    const view = await s.preview({ kind: 'normalizeDate', key: 'date', target: 'date', regionFormat: 'MDY' });
    expect(view.items[0]).toMatchObject({ disposition: 'skip', ambiguousDate: '2024-01-02', reason: 'date-ambiguous' }); expect(view.items[1].reason).toBe('already-normalized');
    const revised = await s.planner.revisePreview(view.id, view.revision, [{ path: 'a.md', beforeHash: view.items[0].decision.beforeHash, dateInterpretationConfirmed: true }]);
    expect(revised.summary.execute).toBe(1);
  });
  it('TC-P05: revisions, exclusion changes and note contents invalidate old plans', async () => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old'); const view = await s.preview({ kind: 'renameTag', from: '#old', to: '#new' });
    const revised = await s.planner.revisePreview(view.id, view.revision, []); expect(() => s.planner.getPrepared(view.id, view.revision)).toThrow('plan-invalid');
    s.vault.setText('a.md', 'Edit #old'); const stale = await s.planner.refreshValidity(view.id, revised.revision); expect(stale.items[0]).toMatchObject({ stale: true, disposition: 'skip' });
    s.settings.excludeGlobs = ['a.md']; const invalid = await s.planner.refreshValidity(view.id, stale.revision); expect(invalid.invalid).toBe('plan-invalid');
  });
  it('TC-P05: new matches are excluded from an already captured preview', async () => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old'); const view = await s.preview({ kind: 'renameTag', from: '#old', to: '#new' }); s.vault.add('b.md', {}, '#old');
    const prepared = s.planner.getPrepared(view.id, view.revision); expect(prepared.changes.map(item => item.path)).toEqual(['a.md']);
  });
  it('TC-P05: aborts delayed requests before publishing or accepting decisions', async () => {
    const s = batchServices(); s.vault.add('a.md', {}, '#old'); const gate = deferred(), started = deferred(), read = s.vault.readText.bind(s.vault), abort = new AbortController();
    vi.spyOn(s.vault, 'readText').mockImplementationOnce(async path => { started.resolve(); await gate.promise; return read(path); });
    const slow = s.planner.createPreview({ operation: { kind: 'renameTag', from: '#old', to: '#a' }, scope: { base: { kind: 'all' }, conditions: [], manuallyExcludedPaths: [] } }, abort.signal);
    const rejected = expect(slow).rejects.toThrow(); await started.promise;
    const fast = await s.preview({ kind: 'renameTag', from: '#old', to: '#b' }); abort.abort(); gate.resolve(); await rejected;
    expect(s.planner.getPrepared(fast.id, fast.revision).changes[0].afterContent).toContain('#b');
  });
  const operations: ChangeOperation[] = [
    { kind: 'renameProperty', from: '作者', to: 'writer' }, { kind: 'mergeProperty', from: '作者', to: 'author' }, { kind: 'deleteProperty', key: '作者' },
    { kind: 'renameTag', from: '#book', to: '#read' }, { kind: 'mergeTag', from: '#book', to: '#read' },
    { kind: 'addProperty', key: 'status', value: 'unread', valueType: 'text', onConflict: 'skip' }, { kind: 'normalizeDate', key: 'date', target: 'date', regionFormat: 'MDY' },
  ];
  it.each(operations)('TC-S06: $kind never writes outside the effective scope', async operation => {
    const s = batchServices(); seedFixtures(s.vault); s.settings.excludeGlobs = ['Books/Templates/**']; const scoped = { ...scope, manuallyExcludedPaths: ['Books/sub/J.md'] };
    const originals = new Map([...s.vault.files].map(([path, file]) => [path, file.content]));
    let view = await s.preview(operation, scoped);
    if (operation.kind === 'normalizeDate') view = await s.planner.revisePreview(view.id, view.revision, view.items.filter(item => item.ambiguousDate).map(item => ({ path: item.path, beforeHash: item.decision.beforeHash, dateInterpretationConfirmed: true })));
    if (view.summary.execute) await s.executor.execute(s.planner.getPrepared(view.id, view.revision));
    for (const path of ['Projects/L.md', 'Bookshelf/K.md', 'Books/Templates/M.md', 'Books/sub/J.md', 'Books/O.md', 'Books/P.md', 'Books/R.md']) expect(await s.vault.readText(path)).toBe(originals.get(path));
  });
  it('TC-X04: reserved fields are rejected at both application write boundaries', async () => {
    const s = batchServices(); s.vault.add('a.md', { tags: ['old'] }); await expect(s.preview({ kind: 'deleteProperty', key: 'tags' })).rejects.toThrow('reserved-key');
    const plan = await s.prepare({ kind: 'renameTag', from: '#old', to: '#new' }); plan.operation = { kind: 'deleteProperty', key: 'tags' };
    await expect(s.executor.execute(plan)).rejects.toThrow('reserved-key'); expect(s.vault.noteWrites).toBe(0);
  });
});
