import { describe, expect, it } from 'vitest';
import type { ConvertTagsToPropertyOperation } from '../src/domain/models';
import { validateOperation } from '../src/domain/operation';
import { decodeJournal } from '../src/domain/journal';
import { parseDecimal } from '../src/domain/value-conversion';
import { sha256Hex } from '../src/infrastructure/hash';
import { allNotesScope, type ScopeQuery } from '../src/domain/scope';
import { batchServices } from './support/vault';
import { CONVERT_SCOPE, loadConvertFixtures, STATUS_RULES, statusOperation, subjectOperation } from './support/fixtures014';

describe('0.1.4 tag-to-property and joint transactions (014-02 & 014-03)', () => {
  it('TC-T01, TC-T04, TC-T05, TC-T07: scalar benchmark with default keep-source-tags', async () => {
    const s = batchServices();
    loadConvertFixtures(s.vault);
    s.vault.config.set('types.json', JSON.stringify({ types: { status: 'text' } }));

    const view = await s.preview(statusOperation(false), CONVERT_SCOPE);
    expect(view.summary.total).toBe(12);
    expect(view.summary.execute).toBe(3); // T01, T09, T12
    expect(view.summary.conflicts).toBe(4); // T02, T03, T05, T11
    expect(view.summary.noop).toBe(5); // T04, T06, T07, T08, T10

    expect(view.items.filter(i => i.disposition === 'execute').map(i => i.path)).toEqual([
      'Cases/Convert/T01.md', 'Cases/Convert/T09.md', 'Cases/Convert/T12.md',
    ]);
    // T10 child tag (#状态/已读/精读) is never matched by exact rule #状态/已读.
    expect(view.items.find(i => i.path === 'Cases/Convert/T10.md')!.reason).toBe('source-missing');
    // T09 two rules with same target value merge cleanly with no conflict.
    expect(view.items.find(i => i.path === 'Cases/Convert/T09.md')!.state).toBe('ready');
    // T03 two rules with different values require resolution regardless of rule order.
    expect(view.items.find(i => i.path === 'Cases/Convert/T03.md')!.reason).toBe('tag-scalar-conflict');
    const reversedOp: ConvertTagsToPropertyOperation = { ...statusOperation(false), rules: [...STATUS_RULES].reverse() };
    const reversedView = await s.preview(reversedOp, CONVERT_SCOPE);
    expect(reversedView.items.find(i => i.path === 'Cases/Convert/T03.md')!.reason).toBe('tag-scalar-conflict');

    // Execute default ready items -> source tags remain, re-running is zero-change for them.
    const plan = s.planner.getPrepared(view.id, view.revision);
    await s.executor.execute(plan);
    expect(s.vault.frontmatter('Cases/Convert/T01.md').status).toBe('done');
    expect(s.vault.frontmatter('Cases/Convert/T01.md').tags).toEqual(['状态/已读']);
    expect(s.vault.frontmatter('Cases/Convert/T12.md').status).toBe('done');
    expect(await s.vault.readText('Cases/Convert/T12.md')).toContain('#状态/已读');

    const rerun = await s.preview(statusOperation(false), CONVERT_SCOPE);
    expect(rerun.summary.execute).toBe(0);
    expect(rerun.items.find(i => i.path === 'Cases/Convert/T01.md')!.state).toBe('noop');
    expect(rerun.items.find(i => i.path === 'Cases/Convert/T03.md')!.reason).toBe('tag-scalar-conflict');
  });

  it('TC-T06, TC-C01, TC-C04, TC-C06: removeSourceTags removes only represented sources, single processText per note, full & partial undo', async () => {
    const s = batchServices();
    loadConvertFixtures(s.vault);
    s.vault.config.set('types.json', JSON.stringify({ types: { status: 'text' } }));

    const t01Before = await s.vault.readText('Cases/Convert/T01.md');
    const t03Before = await s.vault.readText('Cases/Convert/T03.md');
    const t04Before = await s.vault.readText('Cases/Convert/T04.md');
    const t11Before = await s.vault.readText('Cases/Convert/T11.md');

    const view = await s.preview(statusOperation(true), CONVERT_SCOPE);
    // Initial: 4 ready (T01, T04 tag-cleanup-only, T09, T12), 4 conflict (T02, T03, T05, T11), 4 noop.
    expect(view.summary.execute).toBe(4);
    expect(view.summary.conflicts).toBe(4);
    expect(view.summary.noop).toBe(4);

    // Choose done on T03 and T11, keep-existing on T02.
    const t02 = view.items.find(i => i.path === 'Cases/Convert/T02.md')!;
    const t03 = view.items.find(i => i.path === 'Cases/Convert/T03.md')!;
    const t11 = view.items.find(i => i.path === 'Cases/Convert/T11.md')!;
    const revised = await s.planner.revisePreview(view.id, view.revision, [
      { path: t02.path, beforeHash: t02.decision.beforeHash, tagPropertyResolution: { kind: 'keep-existing' } },
      { path: t03.path, beforeHash: t03.decision.beforeHash, tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-done' } },
      { path: t11.path, beforeHash: t11.decision.beforeHash, tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-done' } },
    ]);
    expect(revised.summary.execute).toBe(6);

    const processCounts = new Map<string, number>();
    const origProcess = s.vault.processText.bind(s.vault);
    s.vault.processText = async (path, transform) => {
      processCounts.set(path, (processCounts.get(path) ?? 0) + 1);
      return origProcess(path, transform);
    };

    const plan = s.planner.getPrepared(revised.id, revised.revision);
    const result = await s.executor.execute(plan);
    expect(result.items.filter(i => i.status === 'applied')).toHaveLength(6);

    // Single processText per note; written content matches prepared afterContent exactly.
    for (const change of plan.changes) {
      expect(processCounts.get(change.path)).toBe(1);
      expect(await s.vault.readText(change.path)).toBe(change.afterContent);
    }

    // T03: status=done, #状态/已读 removed from FM & body, #状态/在读 kept in both!
    expect(s.vault.frontmatter('Cases/Convert/T03.md').status).toBe('done');
    expect(s.vault.frontmatter('Cases/Convert/T03.md').tags).toEqual(['状态/在读']);
    expect(await s.vault.readText('Cases/Convert/T03.md')).toContain('#状态/在读');
    expect(await s.vault.readText('Cases/Convert/T03.md')).not.toContain('#状态/已读');

    // T04: property already done, only #状态/已读 removed, #other preserved.
    expect(s.vault.frontmatter('Cases/Convert/T04.md').status).toBe('done');
    expect(s.vault.frontmatter('Cases/Convert/T04.md').tags).toEqual([]);
    expect(await s.vault.readText('Cases/Convert/T04.md')).toContain('#other');

    // T11: tags becomes "keep", tag becomes [], body #状态/已读 removed.
    expect(s.vault.frontmatter('Cases/Convert/T11.md').status).toBe('done');
    expect(s.vault.frontmatter('Cases/Convert/T11.md').tags).toBe('keep');
    expect(s.vault.frontmatter('Cases/Convert/T11.md').tag).toEqual([]);
    expect(await s.vault.readText('Cases/Convert/T11.md')).not.toContain('#状态/已读');

    // T02: keep-existing -> completely untouched.
    expect(s.vault.frontmatter('Cases/Convert/T02.md').status).toBe('unread');
    expect(s.vault.frontmatter('Cases/Convert/T02.md').tags).toEqual(['状态/在读']);

    // Partial recovery: edit T01 externally, then restore -> T01 keeps external edit, others restore byte-for-byte!
    const t01Edited = `${await s.vault.readText('Cases/Convert/T01.md')}user-edit\n`;
    s.vault.setText('Cases/Convert/T01.md', t01Edited);
    const partial = await s.restore(result.transactionId);
    expect(partial.complete).toBe(false);
    expect(await s.vault.readText('Cases/Convert/T01.md')).toBe(t01Edited);
    expect(await s.vault.readText('Cases/Convert/T03.md')).toBe(t03Before);
    expect(await s.vault.readText('Cases/Convert/T04.md')).toBe(t04Before);
    expect(await s.vault.readText('Cases/Convert/T11.md')).toBe(t11Before);
    expect(t01Before).not.toBe(t01Edited);
  });

  it('TC-T03 & TC-T07: list mode preserves existing duplicates, appends in rule order, distinguishes "5" vs 5, handles replace-list', async () => {
    const s = batchServices();
    loadConvertFixtures(s.vault);
    const view = await s.preview(subjectOperation(false), CONVERT_SCOPE);
    expect(view.summary.execute).toBe(2); // T06, T07
    expect(view.summary.conflicts).toBe(1); // T08
    expect(view.summary.noop).toBe(9);

    const t08 = view.items.find(i => i.path === 'Cases/Convert/T08.md')!;
    const revised = await s.planner.revisePreview(view.id, view.revision, [
      { path: t08.path, beforeHash: t08.decision.beforeHash, tagPropertyResolution: { kind: 'replace-list' } },
    ]);
    const plan = s.planner.getPrepared(revised.id, revised.revision);
    await s.executor.execute(plan);

    expect(s.vault.frontmatter('Cases/Convert/T06.md').subjects).toEqual(['science', 'history', 'literature']);
    expect(s.vault.frontmatter('Cases/Convert/T07.md').subjects).toEqual(['history', 'history', 'science', 'literature']);
    expect(s.vault.frontmatter('Cases/Convert/T08.md').subjects).toEqual(['history']);

    // Re-run is idempotent (0 writes).
    const rerun = await s.preview(subjectOperation(false), CONVERT_SCOPE);
    expect(rerun.summary.execute).toBe(0);

    // Typed distinction: "5" !== 5.
    const s2 = batchServices();
    s2.vault.setText('typed.md', '---\ntags: [num]\nvals:\n  - "5"\n---\n');
    const p2 = await s2.prepare({
      kind: 'convertTagsToProperty',
      key: 'vals',
      mode: 'list',
      rules: [{ id: 'r1', tag: '#num', value: { type: 'number', value: 5 } }],
      removeSourceTags: false,
    });
    await s2.executor.execute(p2);
    expect(s2.vault.frontmatter('typed.md').vals).toEqual(['5', 5]);
  });

  it('TC-C03: exact isolated T02/T03/T05 batch applicability, individual exception, atomic rejection, and withdrawal counts 0->2->1->0', async () => {
    const s = batchServices();
    s.vault.setText('Iso/T02.md', '---\ntags:\n  - 状态/在读\nstatus: unread\n---\n');
    s.vault.setText('Iso/T03.md', '---\ntags:\n  - 状态/已读\n  - 状态/在读\n---\n#状态/已读 #状态/在读\n');
    s.vault.setText('Iso/T05.md', '---\nstatus: false\n---\n#状态/已读\n');
    s.vault.config.set('types.json', JSON.stringify({ types: { status: 'text' } }));

    const isoScope: ScopeQuery = {
      base: { kind: 'folder', path: 'Iso', includeSubfolders: true },
      conditions: [],
      manuallyExcludedPaths: [],
    };
    // Step 1: initial all 3 conflict, prepared=0.
    const v1 = await s.preview(statusOperation(false), isoScope);
    expect(v1.summary.total).toBe(3);
    expect(v1.summary.conflicts).toBe(3);
    expect(v1.summary.execute).toBe(0);

    const t02 = v1.items.find(i => i.path === 'Iso/T02.md')!;
    const t03 = v1.items.find(i => i.path === 'Iso/T03.md')!;
    const t05 = v1.items.find(i => i.path === 'Iso/T05.md')!;
    expect(t02.tagAnalysis!.allowedResolutions.some(r => r.kind === 'use-mapped' && r.ruleId === 'r-done')).toBe(false);
    expect(t03.tagAnalysis!.allowedResolutions.some(r => r.kind === 'use-mapped' && r.ruleId === 'r-done')).toBe(true);
    expect(t05.tagAnalysis!.allowedResolutions.some(r => r.kind === 'use-mapped' && r.ruleId === 'r-done')).toBe(true);

    // Step 2: batch r-done sent ONLY to eligible T03 & T05 -> prepared=2, T02 stays conflict.
    const v2 = await s.planner.revisePreview(v1.id, v1.revision, [
      { path: t03.path, beforeHash: t03.decision.beforeHash, tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-done' }, individual: false },
      { path: t05.path, beforeHash: t05.decision.beforeHash, tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-done' }, individual: false },
    ]);
    expect(v2.summary.execute).toBe(2);
    expect(v2.items.find(i => i.path === 'Iso/T02.md')!.reason).toBe('tag-target-conflict');

    // Step 3: T05 set to keep-existing + individual=true -> prepared=1 (only T03).
    const v3 = await s.planner.revisePreview(v2.id, v2.revision, [
      { path: t05.path, beforeHash: t05.decision.beforeHash, tagPropertyResolution: { kind: 'keep-existing' }, individual: true },
    ]);
    expect(v3.summary.execute).toBe(1);
    expect(v3.summary.conflicts).toBe(1); // Only T02 unresolved; T05 is policy-skip!
    expect(v3.summary.skip).toBe(2); // T02 + T05

    // Step 4: invalid patch targeting T02 with r-done (alone or mixed) rejects atomically with no state mutation.
    await expect(s.planner.revisePreview(v3.id, v3.revision, [
      { path: t02.path, beforeHash: t02.decision.beforeHash, tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-done' } },
    ])).rejects.toThrow('invalid-decision');
    await expect(s.planner.revisePreview(v3.id, v3.revision, [
      { path: t03.path, beforeHash: t03.decision.beforeHash, tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-reading' } },
      { path: t02.path, beforeHash: t02.decision.beforeHash, tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-done' } },
    ])).rejects.toThrow('invalid-decision');

    // Step 5: withdraw T03 -> prepared=0, total=3 conserved.
    const v4 = await s.planner.revisePreview(v3.id, v3.revision, [
      { path: t03.path, beforeHash: t03.decision.beforeHash, tagPropertyResolution: null },
    ]);
    expect(v4.summary.execute).toBe(0);
    expect(v4.summary.conflicts).toBe(2); // T02 & T03 unresolved
    expect(v4.summary.total).toBe(3);

    // Executing step-3 decision writes ONLY T03; T02 & T05 untouched.
    const v5 = await s.planner.revisePreview(v4.id, v4.revision, [
      { path: t03.path, beforeHash: t03.decision.beforeHash, tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-done' } },
    ]);
    const t02Hash = await sha256Hex(await s.vault.readText('Iso/T02.md'));
    const t05Hash = await sha256Hex(await s.vault.readText('Iso/T05.md'));
    const plan = s.planner.getPrepared(v5.id, v5.revision);
    await s.executor.execute(plan);
    expect(s.vault.frontmatter('Iso/T03.md').status).toBe('done');
    expect(await sha256Hex(await s.vault.readText('Iso/T02.md'))).toBe(t02Hash);
    expect(await sha256Hex(await s.vault.readText('Iso/T05.md'))).toBe(t05Hash);
  });

  it('TC-T08, TC-X07, TC-X08, TC-X12: declaration mismatch confirmation, switching clears confirmation, corrupt config blocks, config untouched', async () => {
    const s = batchServices();
    s.vault.setText('a.md', '---\ntags: [t1, t2]\n---\n');
    const typesRaw = JSON.stringify({ types: { status: 'number' } });
    s.vault.config.set('types.json', typesRaw);

    const op: ConvertTagsToPropertyOperation = {
      kind: 'convertTagsToProperty',
      key: 'status',
      mode: 'scalar',
      rules: [
        { id: 'r-text', tag: '#t1', value: { type: 'text', value: 'done' } },
        { id: 'r-bool', tag: '#t2', value: { type: 'boolean', value: true } },
      ],
      removeSourceTags: false,
    };
    const v1 = await s.preview(op);
    const a = v1.items[0];
    expect(v1.summary.execute).toBe(0);

    // Same patch cannot both switch candidate and confirm declaration.
    await expect(s.planner.revisePreview(v1.id, v1.revision, [{
      path: a.path,
      beforeHash: a.decision.beforeHash,
      tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-text' },
      declaredTypeMismatchConfirmed: true,
    }])).rejects.toThrow('invalid-decision');

    // Step 1: pick r-text -> now requires declared-type-mismatch confirmation.
    const v2 = await s.planner.revisePreview(v1.id, v1.revision, [{
      path: a.path,
      beforeHash: a.decision.beforeHash,
      tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-text' },
    }]);
    expect(v2.items[0].reason).toBe('declared-type-mismatch');
    expect(v2.summary.execute).toBe(0);

    // Step 2: confirm declaration -> ready!
    const v3 = await s.planner.revisePreview(v2.id, v2.revision, [{
      path: a.path,
      beforeHash: a.decision.beforeHash,
      declaredTypeMismatchConfirmed: true,
    }]);
    expect(v3.summary.execute).toBe(1);

    // Step 3: switch candidate to r-bool -> clears prior declaration confirmation!
    const v4 = await s.planner.revisePreview(v3.id, v3.revision, [{
      path: a.path,
      beforeHash: a.decision.beforeHash,
      tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-bool' },
    }]);
    expect(v4.summary.execute).toBe(0);
    expect(v4.items[0].reason).toBe('declared-type-mismatch');
    expect(v4.items[0].decision.declaredTypeMismatchConfirmed).toBeUndefined();

    // Confirm and execute -> types.json remains byte-identical with zero config writes.
    const v5 = await s.planner.revisePreview(v4.id, v4.revision, [{
      path: a.path,
      beforeHash: a.decision.beforeHash,
      declaredTypeMismatchConfirmed: true,
    }]);
    const plan = s.planner.getPrepared(v5.id, v5.revision);
    expect(plan.typePatch).toBeUndefined();
    let typesWrites = 0;
    const origProcessConfig = s.vault.processConfigFile.bind(s.vault);
    s.vault.processConfigFile = async (path, transform) => {
      if (path === 'types.json') typesWrites++;
      return origProcessConfig(path, transform);
    };
    await s.executor.execute(plan);
    expect(s.vault.frontmatter('a.md').status).toBe(true);
    expect(s.vault.config.get('types.json')).toBe(typesRaw);
    expect(typesWrites).toBe(0);

    // Corrupt types.json blocks conversion completely.
    s.vault.config.set('types.json', '{corrupt');
    const corruptView = await s.preview({
      kind: 'convertTagsToProperty',
      key: 'status',
      mode: 'scalar',
      rules: [{ id: 'r1', tag: '#t1', value: { type: 'text', value: 'done' } }],
      removeSourceTags: true,
    });
    expect(corruptView.summary.execute).toBe(0);
    expect(corruptView.items[0].state).toBe('blocked');
    expect(corruptView.items[0].reason).toBe('type-config-unsupported');
  });

  it('TC-X14: blocks whole note when removing body tag activates adjacent #old#keep or duplicate #keep #old#keep', async () => {
    const s = batchServices();
    s.vault.setText('adj1.md', '\uFEFF#old#keep\r\n');
    s.vault.setText('adj2.md', '#keep #old#keep\n');
    const opRemove: ConvertTagsToPropertyOperation = {
      kind: 'convertTagsToProperty',
      key: 'status',
      mode: 'scalar',
      rules: [{ id: 'r1', tag: '#old', value: { type: 'text', value: 'done' } }],
      removeSourceTags: true,
    };

    const view = await s.preview(opRemove);
    expect(view.summary.execute).toBe(0);
    expect(view.items.every(i => i.state === 'blocked' && i.reason === 'tag-semantics-changed')).toBe(true);
    expect(s.vault.noteWrites).toBe(0);

    // Turning off removeSourceTags allows writing the property safely.
    const viewKeep = await s.preview({ ...opRemove, removeSourceTags: false });
    expect(viewKeep.summary.execute).toBe(2);
    const plan = s.planner.getPrepared(viewKeep.id, viewKeep.revision);
    await s.executor.execute(plan);
    expect(s.vault.frontmatter('adj1.md').status).toBe('done');
    expect(await s.vault.readText('adj1.md')).toContain('#old#keep');
  });

  it('TC-T02, TC-X06, TC-X09, TC-X10, TC-C05, TC-S03: boundary validation, V2 journal decode, stale guard, and retry', async () => {
    // Reserved key & invalid rules rejected.
    expect(() => validateOperation({
      kind: 'convertTagsToProperty',
      key: 'TAGS',
      mode: 'scalar',
      rules: [{ id: 'r1', tag: '#a', value: { type: 'text', value: 'x' } }],
      removeSourceTags: false,
    })).toThrow('reserved-key');
    expect(() => validateOperation({
      kind: 'convertTagsToProperty',
      key: 'score',
      mode: 'scalar',
      rules: [
        { id: 'r1', tag: '#a', value: { type: 'number', value: 1 } },
        { id: 'r2', tag: '#A', value: { type: 'number', value: 2 } },
      ],
      removeSourceTags: false,
    })).toThrow('tag-rule-duplicate');
    expect(() => validateOperation({
      kind: 'convertTagsToProperty',
      key: 'score',
      mode: 'scalar',
      rules: [{ id: 'r1', tag: '#a', value: { type: 'number', value: Number.MAX_SAFE_INTEGER + 2 } }],
      removeSourceTags: false,
    })).toThrow('number-precision');
    expect(parseDecimal('9007199254740993').ok).toBe(false);
    expect(parseDecimal('1.0000000000000001').ok).toBe(false);

    // External edit with unchanged mtime prevents stale overwrite (TC-C05).
    const s = batchServices();
    s.vault.setText('a.md', '#状态/已读\n');
    s.vault.setText('b.md', '#状态/已读\n');
    const view = await s.preview(statusOperation(true));
    const plan = s.planner.getPrepared(view.id, view.revision);
    const sameMtime = s.vault.files.get('a.md')!.mtime;
    s.vault.files.set('a.md', { content: '#状态/已读 external\n', mtime: sameMtime });

    const res = await s.executor.execute(plan);
    expect(res.items.find(i => i.path === 'a.md')!.status).toBe('stale');
    expect(res.items.find(i => i.path === 'b.md')!.status).toBe('applied');
    expect(await s.vault.readText('a.md')).toBe('#状态/已读 external\n');

    // Retry targets only stale path 'a.md', not already-applied 'b.md'.
    await s.coordinator.initialize();
    const retryView = await s.coordinator.retry(res.transactionId, 'stale');
    expect(retryView.items.map(i => i.path)).toEqual(['a.md']);

    // Journal V2 decode validates new kinds and classifies unknown future kind as unsupported.
    const futureRaw = JSON.stringify({
      schemaVersion: 2,
      transactionId: 'tx_future',
      planId: 'pc_future',
      createdAt: 1,
      operation: { kind: 'futureTagRule', x: 1 },
      scope: allNotesScope(),
      scopeSummary: { base: { kind: 'all' }, conditions: [], matched: 0, manual: 0, effective: 0, unknown: 0 },
      entries: [],
      skipped: [],
      stateBudgetBytes: 1024,
    });
    expect((await decodeJournal(futureRaw, null, 'tx_future', sha256Hex)).kind).toBe('unsupported');
  });

  it('TC-T05, TC-C01, TC-S02, TC-P02: empty/zero/complex targets, non-string array preservation, fault injection, and 500-note preview budget', async () => {
    // TC-T05 & TC-C01: empty string, empty list, 0, object, nested array, and non-string tag members.
    const s = batchServices();
    s.vault.setText('empty-str.md', '---\ntags: [123, false, "状态/已读"]\nstatus: ""\n---\n');
    s.vault.setText('empty-list.md', '---\ntags: [状态/已读]\nstatus: []\n---\n');
    s.vault.setText('zero.md', '---\ntags: [状态/已读]\nstatus: 0\n---\n');
    s.vault.setText('obj.md', '---\ntags: [状态/已读]\nstatus:\n  nested: 1\n---\n');
    s.vault.setText('null-list.md', '---\ntags: [学科/历史]\nsubjects:\n  - science\n  - null\n---\n');

    const vScalar = await s.preview(statusOperation(true));
    expect(vScalar.items.find(i => i.path === 'empty-str.md')!.reason).toBe('tag-target-conflict');
    expect(vScalar.items.find(i => i.path === 'empty-list.md')!.reason).toBe('tag-target-conflict');
    expect(vScalar.items.find(i => i.path === 'zero.md')!.reason).toBe('tag-target-conflict');
    expect(vScalar.items.find(i => i.path === 'obj.md')!.state).toBe('blocked');
    expect(vScalar.items.find(i => i.path === 'obj.md')!.reason).toBe('tag-target-unsupported');

    // Adopting r-done on empty-str.md preserves non-string array members [123, false] while removing 状态/已读.
    const emptyStr = vScalar.items.find(i => i.path === 'empty-str.md')!;
    const rev = await s.planner.revisePreview(vScalar.id, vScalar.revision, [{
      path: emptyStr.path,
      beforeHash: emptyStr.decision.beforeHash,
      tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-done' },
    }]);
    await s.executor.execute(s.planner.getPrepared(rev.id, rev.revision));
    expect(s.vault.frontmatter('empty-str.md').status).toBe('done');
    expect(s.vault.frontmatter('empty-str.md').tags).toEqual([123, false]);

    const vList = await s.preview(subjectOperation(false));
    expect(vList.items.find(i => i.path === 'null-list.md')!.state).toBe('blocked');
    expect(vList.items.find(i => i.path === 'null-list.md')!.reason).toBe('tag-target-unsupported');

    // TC-S02: post-commit error marks note as uncertain and sets requiresReconciliation.
    const sFault = batchServices();
    sFault.vault.setText('f1.md', '#状态/已读\n');
    sFault.vault.setText('f2.md', '#状态/已读\n');
    const faultPlan = await sFault.prepare(statusOperation(true));
    const origProcess = sFault.vault.processText.bind(sFault.vault);
    sFault.vault.processText = async (path, transform) => {
      await origProcess(path, transform);
      if (path === 'f1.md') throw new Error('post-commit-io');
      return sFault.vault.readText(path);
    };
    const faultResult = await sFault.executor.execute(faultPlan);
    expect(faultResult.requiresReconciliation).toBe(true);
    expect(faultResult.items.find(i => i.path === 'f1.md')!.status).toBe('uncertain');
    expect(faultResult.items.find(i => i.path === 'f2.md')!.status).toBe('not-run');

    // TC-P02: 500-note formal preview (fresh read + compose + re-parse + collision check) completes cleanly and supports abort.
    const sPerf = batchServices();
    for (let i = 0; i < 500; i++) {
      sPerf.vault.setText(`Perf/n-${i}.md`, `---\ntags:\n  - 状态/已读\n---\nBody text for note ${i} #状态/已读 #other\n`);
    }
    const t0 = performance.now();
    const perfView = await sPerf.preview(statusOperation(true));
    const elapsed = performance.now() - t0;
    expect(perfView.summary.execute).toBe(500);
    expect(elapsed).toBeLessThan(5000);
  });

  it('Review #1: repeating batch resolution preserves manually unchecked notes (selected: false)', async () => {
    const s = batchServices();
    s.vault.setText('a.md', '---\ntags: [状态/已读]\nstatus: old\n---\n#状态/已读\n');
    s.vault.setText('b.md', '---\ntags: [状态/已读]\nstatus: old\n---\n#状态/已读\n');

    const v1 = await s.preview(statusOperation(true));
    const [a, b] = v1.items;

    // Step 1: batch adopt r-done (omitting `selected`, matching PreviewDrawer batch behavior).
    const v2 = await s.planner.revisePreview(v1.id, v1.revision, [
      { path: a.path, beforeHash: a.decision.beforeHash, tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-done' }, individual: false },
      { path: b.path, beforeHash: b.decision.beforeHash, tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-done' }, individual: false },
    ]);
    expect(v2.summary.execute).toBe(2);

    // Step 2: manually uncheck note b.
    const v3 = await s.planner.revisePreview(v2.id, v2.revision, [
      { path: b.path, beforeHash: b.decision.beforeHash, selected: false },
    ]);
    expect(v3.summary.execute).toBe(1);
    expect(v3.items.find(i => i.path === 'b.md')!.reason).toBe('user-unselected');

    // Step 3: repeat batch adopt r-done -> note b MUST stay deselected and untouched!
    const v4 = await s.planner.revisePreview(v3.id, v3.revision, [
      { path: a.path, beforeHash: a.decision.beforeHash, tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-done' }, individual: false },
      { path: b.path, beforeHash: b.decision.beforeHash, tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-done' }, individual: false },
    ]);
    expect(v4.summary.execute).toBe(1);
    expect(v4.items.find(i => i.path === 'b.md')!.decision.selected).toBe(false);
    expect(v4.items.find(i => i.path === 'b.md')!.disposition).toBe('skip');

    const bBefore = await s.vault.readText('b.md');
    await s.executor.execute(s.planner.getPrepared(v4.id, v4.revision));
    expect(s.vault.frontmatter('a.md').status).toBe('done');
    expect(await s.vault.readText('b.md')).toBe(bBefore);
  });

  it('Review #5: failed write retry preserves negative zero (-0) through V2 journal serialization', async () => {
    const s = batchServices();
    s.vault.setText('neg.md', '---\ntags: [zero]\n---\n');
    const op: ConvertTagsToPropertyOperation = {
      kind: 'convertTagsToProperty',
      key: 'score',
      mode: 'scalar',
      rules: [{ id: 'r-neg0', tag: '#zero', value: { type: 'number', value: -0 } }],
      removeSourceTags: false,
    };

    const v1 = await s.preview(op);
    const plan1 = s.planner.getPrepared(v1.id, v1.revision);
    expect(plan1.changes[0].afterContent).toContain('score: -0');

    // Inject pre-commit failure on first attempt so retry runs from persisted V2 journal.
    const origProcess = s.vault.processText.bind(s.vault);
    let failOnce = true;
    s.vault.processText = async (path, transform) => {
      if (failOnce) { failOnce = false; throw new Error('disk-busy'); }
      return origProcess(path, transform);
    };
    const res1 = await s.executor.execute(plan1);
    expect(res1.items[0].status).toBe('failed');

    await s.coordinator.initialize();
    const retryView = await s.coordinator.retry(res1.transactionId, 'failed');
    const retryPlan = s.planner.getPrepared(retryView.id, retryView.revision);
    expect(retryPlan.changes[0].afterContent).toContain('score: -0');
    await s.executor.execute(retryPlan);
    expect(Object.is(s.vault.frontmatter('neg.md').score, -0)).toBe(true);
  });

  it('Review #6: aborting during candidate verification stops immediately without evaluating remaining notes', async () => {
    const s = batchServices();
    for (let i = 0; i < 40; i++) {
      s.vault.setText(`n-${String(i).padStart(2, '0')}.md`, '---\ntags: [状态/已读]\n---\n#状态/已读\n');
    }
    const abort = new AbortController();
    const origReadBound = s.vault.readBoundTags.bind(s.vault);
    let candidateVerifyCalls = 0;
    let captureCalls = 0;
    s.vault.readBoundTags = async (path, source) => {
      // First 40 calls are during capture phase; call #41 is candidate verification of note #1.
      if (captureCalls < 40) {
        captureCalls++;
      } else {
        candidateVerifyCalls++;
        if (candidateVerifyCalls === 1) abort.abort();
      }
      return origReadBound(path, source);
    };

    await expect(s.planner.createPreview({ operation: statusOperation(true), scope: allNotesScope() }, abort.signal)).rejects.toThrow();
    expect(candidateVerifyCalls).toBe(1);
  });

  it('Re-review #3: replacing existing score: 0 with -0 encodes YAML update and allows source tag removal', async () => {
    const s = batchServices();
    s.vault.setText('zero.md', '---\nscore: 0\n---\n#zero\n');
    const op: ConvertTagsToPropertyOperation = {
      kind: 'convertTagsToProperty',
      key: 'score',
      mode: 'scalar',
      rules: [{ id: 'r-neg0', tag: '#zero', value: { type: 'number', value: -0 } }],
      removeSourceTags: true,
    };

    const v1 = await s.preview(op);
    const item = v1.items[0];
    expect(item.state).toBe('conflict');
    expect(item.reason).toBe('tag-target-conflict');

    const v2 = await s.planner.revisePreview(v1.id, v1.revision, [{
      path: item.path,
      beforeHash: item.decision.beforeHash,
      tagPropertyResolution: { kind: 'use-mapped', ruleId: 'r-neg0' },
    }]);
    expect(v2.summary.execute).toBe(1);
    expect(v2.items[0].diffs.find(d => d.label === 'score')).toMatchObject({ before: '0 (number)', after: '-0 (number)' });

    await s.executor.execute(s.planner.getPrepared(v2.id, v2.revision));
    expect(Object.is(s.vault.frontmatter('zero.md').score, -0)).toBe(true);
    expect(await s.vault.readText('zero.md')).not.toContain('#zero');

    // List append [0] -> [0, -0] must render -0 accurately in preview diff.
    const sList = batchServices();
    sList.vault.setText('list-zero.md', '---\nscores:\n  - 0\n---\n#zero\n');
    const vList = await sList.preview({
      kind: 'convertTagsToProperty',
      key: 'scores',
      mode: 'list',
      rules: [{ id: 'r-neg0', tag: '#zero', value: { type: 'number', value: -0 } }],
      removeSourceTags: false,
    });
    expect(vList.items[0].diffs.find(d => d.label === 'scores')).toMatchObject({
      before: '[0] (list)',
      after: '[0,-0] (list)',
    });
    await sList.executor.execute(sList.planner.getPrepared(vList.id, vList.revision));
    const finalScores = sList.vault.frontmatter('list-zero.md').scores as number[];
    expect(Object.is(finalScores[0], 0)).toBe(true);
    expect(Object.is(finalScores[1], -0)).toBe(true);
  });

  it('Re-review #4: history retry preview honors AbortSignal cancellation and clears coordinator busy state', async () => {
    const s = batchServices();
    for (let i = 0; i < 10; i++) {
      s.vault.setText(`r-${i}.md`, '---\ntags: [状态/已读]\n---\n#状态/已读\n');
    }
    const plan = await s.prepare(statusOperation(true));
    const origProcess = s.vault.processText.bind(s.vault);
    s.vault.processText = async () => { throw new Error('disk-err'); };
    const res = await s.executor.execute(plan);
    s.vault.processText = origProcess;
    await s.coordinator.initialize();

    const abort = new AbortController();
    const origReadBound = s.vault.readBoundTags.bind(s.vault);
    let calls = 0;
    s.vault.readBoundTags = async (path, source) => {
      calls++;
      if (calls === 11) abort.abort(); // First candidate verification during retry
      return origReadBound(path, source);
    };

    await expect(s.coordinator.retry(res.transactionId, 'failed', abort.signal)).rejects.toThrow();
    expect(calls).toBe(11);
    expect(s.coordinator.isBusy()).toBe(false);
  });
});
