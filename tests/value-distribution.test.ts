import { describe, expect, it } from 'vitest';
import { batchServices } from './support/vault';
import { seedV013, scope013 } from './support/fixtures013';
import { ScopeService } from '../src/application/ScopeService';
import { PropertyValueService } from '../src/application/PropertyValueService';
import { buildDistribution } from '../src/domain/value-distribution';
import { fileMeta } from '../src/application/file-meta';
import type { ScopeResult } from '../src/domain/scope';

function setup() {
  const s = batchServices();
  s.settings.excludeGlobs = ['Books/Templates/**'];
  seedV013(s.vault);
  const snapshot = s.snapshot();
  const scopeService = new ScopeService(() => s.settings);
  const valueService = new PropertyValueService(s.types, () => s.settings);
  const analyze = async (mode: 'field' | 'member', key = 'status') => {
    const scope = await scopeService.evaluate(scope013, snapshot, { requestId: snapshot.revision });
    return { scope, distribution: await valueService.analyze(snapshot, scope, { key, mode }, { requestId: 7 }) };
  };
  return { s, snapshot, analyze };
}

function count(record: Readonly<Record<string, readonly string[]>>, key: string): number {
  return record[key]?.length ?? 0;
}

describe('0.1.3 value distribution', () => {
  it('TC-D01/D02/D03: partitions the base scope and keeps actual types independent of declarations', async () => {
    const { analyze } = setup();
    const { scope, distribution } = await analyze('field');
    expect(scope.summary).toMatchObject({ matched: 21, manual: 1, effective: 20, unknown: 0 });
    expect(distribution.effectiveNoteCount).toBe(20);
    expect(distribution.countedNoteCount).toBe(19);
    expect(distribution.unreadablePaths).toEqual(['Books/Broken.md']);
    expect(distribution.scopeUnknownPaths).toEqual([]);
    expect(distribution.declaration).toEqual({ kind: 'absent' });
    expect({
      missing: count(distribution.states, 'missing'),
      null: count(distribution.states, 'null'),
      emptyText: count(distribution.states, 'empty-text'),
      emptyList: count(distribution.states, 'empty-list'),
      whitespace: count(distribution.states, 'whitespace'),
      nonempty: count(distribution.states, 'nonempty'),
    }).toEqual({ missing: 2, null: 1, emptyText: 1, emptyList: 1, whitespace: 1, nonempty: 13 });
    expect({
      text: count(distribution.actualTypePaths, 'text'),
      number: count(distribution.actualTypePaths, 'number'),
      boolean: count(distribution.actualTypePaths, 'boolean'),
      list: count(distribution.actualTypePaths, 'list'),
      null: count(distribution.actualTypePaths, 'null'),
      object: count(distribution.actualTypePaths, 'object'),
    }).toEqual({ text: 7, number: 2, boolean: 1, list: 5, null: 1, object: 1 });
    // Quantity is conserved through bucket note counts plus missing paths.
    const bucketNotes = distribution.buckets.reduce((sum, bucket) => sum + bucket.notePaths.length, 0);
    expect(bucketNotes + count(distribution.states, 'missing')).toBe(distribution.countedNoteCount);
    expect(distribution.buckets).toHaveLength(17);
    // "5" (text) and 5 (number) are distinct buckets.
    const values = distribution.buckets.map(bucket => bucket.raw);
    expect(values).toContain('5');
    expect(values).toContain(5);
  });

  it('TC-D04: member view dedupes repeated members per note', async () => {
    const { analyze } = setup();
    const { distribution } = await analyze('member');
    expect(distribution.listNoteCount).toBe(5);
    expect(distribution.nonListPresentNoteCount).toBe(12);
    expect(distribution.buckets).toHaveLength(7);
    const contributions = distribution.buckets.reduce((sum, bucket) => sum + bucket.notePaths.length, 0);
    expect(contributions).toBe(10);
    const done = distribution.buckets.find(bucket => bucket.raw === 'done');
    const finished = distribution.buckets.find(bucket => bucket.raw === 'finished');
    expect([...(done?.notePaths ?? [])].sort()).toEqual(['Books/N.md', 'Books/O.md']);
    expect(finished?.notePaths).toEqual(['Books/P.md']);
  });

  it('TC-D02: a declaration does not overwrite actual type counts', async () => {
    const s = batchServices();
    s.settings.excludeGlobs = ['Books/Templates/**'];
    seedV013(s.vault);
    s.vault.config.set('types.json', JSON.stringify({ types: { status: 'number', readAt: 'date' } }));
    const snapshot = s.snapshot();
    const scopeService = new ScopeService(() => s.settings);
    const valueService = new PropertyValueService(s.types, () => s.settings);
    const scope = await scopeService.evaluate(scope013, snapshot, { requestId: snapshot.revision });
    const distribution = await valueService.analyze(snapshot, scope, { key: 'status', mode: 'field' }, { requestId: 1 });
    expect(distribution.declaration).toEqual({ kind: 'known', type: 'number' });
    expect(count(distribution.actualTypePaths, 'text')).toBe(7);
    const readAt = await valueService.analyze(snapshot, scope, { key: 'readAt', mode: 'field' }, { requestId: 2 });
    expect(count(readAt.actualTypePaths, 'text')).toBe(4);
  });

  it('rejects snapshots whose revision does not match the scope', async () => {
    const { s, analyze } = setup();
    const { scope } = await analyze('field');
    const valueService = new PropertyValueService(s.types, () => s.settings);
    await expect(valueService.analyze(s.snapshot(), { ...scope, snapshotRevision: 999 } as ScopeResult, { key: 'status', mode: 'field' }, { requestId: 1 }))
      .rejects.toThrow('metadata-stale');
  });

  it('buildDistribution is a pure function over decoded metas', () => {
    const files = [
      fileMeta('a.md', 1, { frontmatter: { status: 'x' }, bodyTags: [] }),
      fileMeta('b.md', 1, { frontmatter: { status: 'x' }, bodyTags: [] }),
      fileMeta('c.md', 1, { frontmatter: {}, bodyTags: [] }),
    ];
    const dist = buildDistribution({ requestId: 1, snapshotRevision: 1, scopeFingerprint: 'f', settingsFingerprint: 'g', key: 'status', mode: 'field', declaration: { kind: 'absent' }, files, scopeUnknownPaths: [] });
    expect(dist.buckets).toHaveLength(1);
    expect(dist.buckets[0].notePaths).toEqual(['a.md', 'b.md']);
    expect(count(dist.states, 'missing')).toBe(1);
  });
});
