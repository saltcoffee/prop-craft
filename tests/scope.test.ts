import { describe, expect, it } from 'vitest';
import { allNotesScope, matchScope, validateScope, type ScopeCondition, type ScopeQuery } from '../src/domain/scope';
import { ScopeService } from '../src/application/ScopeService';
import { MemoryVault, batchServices } from './support/vault';
import { seedFixtures } from './support/fixtures';
const base: ScopeQuery = { base: { kind: 'folder', path: 'Books', includeSubfolders: true }, conditions: [
  { id: 'tag', kind: 'tag', tag: '#book', operator: 'contains', includeDescendants: false }, { id: 'property', kind: 'property', key: 'status', operator: 'missing' },
], manuallyExcludedPaths: [] };
function fixtureScope() {
  const s = batchServices(); seedFixtures(s.vault); s.settings.excludeTemplates = false; s.settings.excludeGlobs = ['Books/Templates/**'];
  const service = new ScopeService(() => s.settings);
  const evaluate = (query = base) => service.evaluate(query, s.snapshot(), { requestId: 1 });
  return { ...s, service, evaluate };
}
describe('0.1.2 shared scope', () => {
  it('TC-S01/04/05: the 22-note baseline partitions all candidates correctly', async () => {
    const s = fixtureScope(), result = await s.evaluate();
    expect(s.vault.files.size).toBe(22); expect(result.globallyExcludedPaths).toEqual(['Books/Templates/M.md']); expect(result.candidatePaths).toHaveLength(19);
    expect(result.matchedPaths).toEqual(['Books/A.md', 'Books/Q.md', 'Books/sub/J.md']);
    expect(result.unknownPaths).toEqual(['Books/P.md', 'Books/R.md']); expect(result.noMatchPaths).toHaveLength(14);
    const excluded = await s.evaluate({ ...base, manuallyExcludedPaths: ['Books/sub/J.md', 'Books/Templates/M.md'] });
    expect(excluded.summary).toMatchObject({ matched: 3, manual: 1, effective: 2, unknown: 2 }); expect(excluded.effectivePaths).toEqual(['Books/A.md', 'Books/Q.md']);
    const direct = await s.evaluate({ ...base, base: { kind: 'folder', path: 'Books', includeSubfolders: false } }); expect(direct.effectivePaths).not.toContain('Books/sub/J.md');
    expect(direct.candidatePaths).not.toContain('Bookshelf/K.md');
    s.vault.unavailableTags.clear(); const resolved = await s.evaluate(); expect(resolved.matchedPaths).toContain('Books/R.md'); expect(resolved.unknownPaths).toEqual(['Books/P.md']);
  });
  it('TC-S02: tag identity ignores case but respects separators and descendant boundaries', async () => {
    const s = fixtureScope();
    const tagOnly = (tag: string, includeDescendants = false): ScopeQuery => ({ ...base, conditions: [{ id: 't', kind: 'tag', operator: 'contains', tag, includeDescendants }] });
    const books = await s.evaluate(tagOnly('#book')); expect(books.matchedPaths).toContain('Books/B.md'); expect(books.matchedPaths).not.toContain('Books/N.md'); expect(books.matchedPaths).not.toContain('Books/O.md');
    expect((await s.evaluate(tagOnly('#book', true))).matchedPaths).toContain('Books/N.md');
    expect((await s.evaluate(tagOnly('#a/b', true))).matchedPaths).toEqual(['Books/U.md']);
    expect((await s.evaluate(tagOnly('#deep_work'))).matchedPaths).toEqual(['Books/S.md']);
    const not = await s.evaluate({ ...base, conditions: [{ id: 't', kind: 'tag', operator: 'not-contains', tag: '#book', includeDescendants: false }] });
    expect(not.unknownPaths).toEqual(['Books/P.md', 'Books/R.md']); expect(not.matchedPaths).not.toContain('Books/B.md');
  });
  it('TC-S03: strict scalar equality, emptiness, and missingness stay distinct', async () => {
    const s = fixtureScope();
    const property = (condition: ScopeCondition): ScopeQuery => ({ ...base, conditions: [base.conditions[0], condition] });
    expect((await s.evaluate(property({ id: 'p', kind: 'property', key: 'status', operator: 'empty' }))).matchedPaths).toEqual(['Books/B.md', 'Books/C.md', 'Books/D.md']);
    expect((await s.evaluate(property({ id: 'p', kind: 'property', key: 'status', operator: 'equals', value: '5' }))).matchedPaths).toEqual(['Books/H.md']);
    expect((await s.evaluate(property({ id: 'p', kind: 'property', key: 'status', operator: 'equals', value: 5 }))).matchedPaths).toEqual(['Books/I.md']);
  });
  it.each([null, '', [], ' ', '\t', 0, false, ['']])('TC-S03: classifies %j without coercion', value => {
    const vault = new MemoryVault(); vault.add('a.md', { value });
    const query: ScopeQuery = { ...allNotesScope(), conditions: [{ id: 'p', kind: 'property', key: 'value', operator: 'empty' }] };
    expect(matchScope(vault.meta('a.md'), query)).toBe(value === null || value === '' || Array.isArray(value) && value.length === 0 ? 'match' : 'no-match');
    expect(matchScope(vault.meta('a.md'), { ...query, conditions: [{ id: 'p', kind: 'property', key: 'value', operator: 'exists' }] })).toBe('match');
  });
  it('TC-S03: literal property names use own keys, including prototype-like names', () => {
    const vault = new MemoryVault(); vault.setText('a.md', '---\n"__proto__": 5\n"a.b": false\nStatus: done\n---\n');
    for (const [key, value] of [['__proto__', 5], ['a.b', false], ['Status', 'done']] as const) expect(matchScope(vault.meta('a.md'), { ...allNotesScope(), conditions: [{ id: 'p', kind: 'property', key, operator: 'equals', value }] })).toBe('match');
    expect(matchScope(vault.meta('a.md'), { ...allNotesScope(), conditions: [{ id: 'p', kind: 'property', key: 'toString', operator: 'exists' }] })).toBe('no-match');
  });
  it.each(['../Books', '/Books', 'C:/Books', 'Books/../Other', 'Missing', 'Books\\sub'])('TC-S01: refuses invalid or nonexistent folder %s', path => {
    expect(() => validateScope({ ...base, base: { kind: 'folder', path, includeSubfolders: true } }, ['Books'])).toThrow('scope-invalid');
  });
  it.each([NaN, Infinity, -Infinity])('TC-S03: rejects nonfinite equality input %s', value => {
    expect(() => validateScope({ ...allNotesScope(), conditions: [{ id: 'p', kind: 'property', key: 'value', operator: 'equals', value }] }, [])).toThrow('scope-invalid');
  });
  it('TC-S04: three-valued AND gives definite nonmatches priority over unknown tags', () => {
    const vault = new MemoryVault(); vault.add('a.md', { status: 'done' }); vault.unavailableTags.add('a.md');
    expect(matchScope(vault.meta('a.md'), base)).toBe('no-match');
    expect(matchScope(vault.meta('a.md'), { ...base, conditions: [base.conditions[0]] })).toBe('no-match'); // folder is outside base
    const inFolder = { ...base, base: { kind: 'all' as const } };
    expect(matchScope(vault.meta('a.md'), inFolder)).toBe('no-match');
    expect(matchScope(vault.meta('a.md'), { ...inFolder, conditions: [base.conditions[0]] })).toBe('unknown');
  });
  it('TC-S06: aggregates only the effective paths, retaining global data separately', async () => {
    const s = fixtureScope(), scope = await s.evaluate({ ...base, manuallyExcludedPaths: ['Books/sub/J.md'] });
    const global = s.snapshot(), scoped = s.service.aggregate(global, scope);
    expect(scoped.files.size).toBe(2); expect(scoped.properties.has('status')).toBe(false); expect(scoped.tags.get('#book')?.fileCount).toBe(2); expect(global.files.size).toBe(22);
  });
});
