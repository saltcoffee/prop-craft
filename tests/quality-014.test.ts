import { describe, expect, it, vi } from 'vitest';
import { VaultIndexer } from '../src/application/VaultIndexer';
import { decodeJournal } from '../src/domain/journal';
import { isChangeOperation } from '../src/domain/operation';
import { planAddProperty, rewriteFrontmatterTag } from '../src/domain/plan';
import { validateValueMapping } from '../src/domain/value-mapping';
import { sha256Hex } from '../src/infrastructure/hash';
import { allNotesScope } from '../src/domain/scope';
import { batchServices } from './support/vault';

describe('0.1.4 code-warning fixes and regressions (014-04 / TC-Q01–TC-Q06)', () => {
  it('TC-Q01 & TC-Q02: VaultIndexer pairs window.setTimeout / window.clearTimeout and leaves no stale callbacks after stop', async () => {
    vi.useFakeTimers();
    const s = batchServices();
    s.vault.add('a.md', { status: 'draft' });
    const indexer = new VaultIndexer(
      s.vault,
      s.store,
      { getSettings: () => s.settings, getTypes: () => new Map() },
      s.codec,
    );
    try {
      const rebuild = indexer.rebuild();
      await vi.runAllTimersAsync();
      await rebuild;
      const rev1 = s.store.get()!.revision;
      s.vault.add('b.md', { status: 'done' });
      indexer.onCreated('b.md');
      // Wait for async read to schedule publish, then stop before 200ms timer fires.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      indexer.stop();
      await vi.runAllTimersAsync();
      expect(s.store.get()!.revision).toBe(rev1);
    } finally {
      indexer.stop();
      vi.useRealTimers();
    }
  });

  it('TC-Q03: removing redundant assertions preserves V2/legacy journal validation and unknown/invalid classification', async () => {
    const validContent = '---\nstatus: a\n---\n';
    const valid = JSON.stringify({
      schemaVersion: 2,
      transactionId: 'tx_q03',
      planId: 'pc_q03',
      createdAt: 100,
      operation: { kind: 'renameProperty', from: 'status', to: 'state' },
      scope: allNotesScope(),
      scopeSummary: { base: { kind: 'all' }, conditions: [], matched: 1, manual: 0, effective: 1, unknown: 0 },
      entries: [{ path: 'a.md', beforeContent: validContent, beforeHash: await sha256Hex(validContent), expectedAfterHash: await sha256Hex('---\nstate: a\n---\n') }],
      skipped: [],
      stateBudgetBytes: 2048,
    });
    expect((await decodeJournal(valid, null, 'tx_q03', sha256Hex)).kind).toBe('v2');

    const unknownKind = JSON.stringify({ ...JSON.parse(valid), operation: { kind: 'unknownOp99' } });
    expect((await decodeJournal(unknownKind, null, 'tx_q03', sha256Hex)).kind).toBe('unsupported');

    expect(isChangeOperation({ kind: 'mapPropertyValues', key: 'k', mode: 'field', rules: [], fill: { states: ['missing'], target: { type: 'list', value: [{ type: 'number', value: 1 }] } } })).toBe(true);
    expect(isChangeOperation({ kind: 'mapPropertyValues', key: 'k', mode: 'field', rules: [], fill: { states: ['missing'], target: { type: 'list', value: [{ type: 'number', value: Number.MAX_SAFE_INTEGER + 2 }] } } })).toBe(false);
  });

  it('TC-Q04: rewriteFrontmatterTag preserves unknown non-string members and unrelated duplicates', () => {
    const fm: Record<string, unknown> = { tags: ['old', 42, false, null, 'keep', 'keep'] };
    const rewritten = rewriteFrontmatterTag(fm, '#old', '#new', 'tags');
    expect(rewritten).toEqual({ key: 'tags', value: ['new', 42, false, null, 'keep', 'keep'] });
  });

  it('TC-Q05: planAddProperty append preserves false, 0, and exact member types and order', () => {
    const s = batchServices();
    s.vault.add('a.md', { flag: false });
    const c1 = planAddProperty(s.vault.meta('a.md'), 'flag', 5, 'number', 'append')!;
    expect(c1.afterFrontmatter.flag).toEqual([false, 5]);

    s.vault.add('b.md', { mix: [0, false, '5'] });
    const c2 = planAddProperty(s.vault.meta('b.md'), 'mix', 5, 'number', 'append')!;
    expect(c2.afterFrontmatter.mix).toEqual([0, false, '5', 5]);
  });

  it('TC-Q06: validateValueMapping validates fill states strictly and rejects invalid runtime states', () => {
    const valid = validateValueMapping({
      kind: 'mapPropertyValues',
      key: 'status',
      mode: 'field',
      rules: [],
      fill: { states: ['missing', 'null', 'empty-text', 'empty-list'], target: { type: 'text', value: 'none' } },
    });
    expect(valid).toEqual([]);

    const invalid = validateValueMapping({
      kind: 'mapPropertyValues',
      key: 'status',
      mode: 'field',
      rules: [],
      fill: { states: ['bogus' as never], target: { type: 'text', value: 'none' } },
    });
    expect(invalid.some(i => i.code === 'input-invalid')).toBe(true);
  });
});
