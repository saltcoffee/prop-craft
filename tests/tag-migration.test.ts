import { describe, expect, it } from 'vitest';
import type { MigrateTagBranchOperation } from '../src/domain/models';
import { isCompleteTagToken, validateTagPath } from '../src/domain/normalize';
import { validateOperation } from '../src/domain/operation';
import { decodeJournal } from '../src/domain/journal';
import { buildTagTree } from '../src/domain/tag-tree';
import { ScopeService } from '../src/application/ScopeService';
import { allNotesScope, type ScopeQuery } from '../src/domain/scope';
import { sha256Hex } from '../src/infrastructure/hash';
import { batchServices } from './support/vault';
import { BRANCH_SCOPE, loadBranchFixtures } from './support/fixtures014';

describe('0.1.4 tag branch migration (014-01)', () => {
  it('TC-B02 & TC-B03 & TC-B04: exact vs descendants, suffix preservation, deduplication, and post-migration counts', async () => {
    const s = batchServices();
    loadBranchFixtures(s.vault);
    const b06Before = await s.vault.readText('Cases/Branch/B06.md');

    // Exact mode modifies only B01, B04, B08 (3 notes).
    const exactOp: MigrateTagBranchOperation = { kind: 'migrateTagBranch', from: '#a/b', to: '#x', includeDescendants: false };
    const exactView = await s.preview(exactOp, BRANCH_SCOPE);
    expect(exactView.summary.execute).toBe(3);
    expect(exactView.items.filter(i => i.disposition === 'execute').map(i => i.path)).toEqual([
      'Cases/Branch/B01.md', 'Cases/Branch/B04.md', 'Cases/Branch/B08.md',
    ]);

    // Descendants mode modifies 5 notes (B01, B02, B03, B04, B08).
    const branchOp: MigrateTagBranchOperation = { kind: 'migrateTagBranch', from: '#a/b', to: '#x', includeDescendants: true };
    const view = await s.preview(branchOp, BRANCH_SCOPE);
    expect(view.summary.execute).toBe(5);
    expect(view.typeSummary.kind).toBe('none');
    expect(view.tagBranchSummary).toBeDefined();

    // Verify mapping table lists all 3 real source identities and spelling variants.
    const mappings = view.tagBranchSummary!.mappings;
    expect(mappings.map(m => m.sourceId)).toEqual(['a/b', 'a/b/c', 'a/b/d']);
    expect(mappings.find(m => m.sourceId === 'a/b')!.sourceVariants).toEqual(['#A/B', '#a/b']);

    // Collisions report existing #x (B04) and #x/c (B03, B08).
    const collisions = view.tagBranchSummary!.collisions;
    expect(collisions.matches.find(m => m.targetId === 'x')!.freshPaths).toEqual(['Cases/Branch/B04.md']);
    expect(collisions.matches.find(m => m.targetId === 'x/c')!.freshPaths).toEqual(['Cases/Branch/B03.md', 'Cases/Branch/B08.md']);

    // Execute and check exact rewritten files.
    const plan = s.planner.getPrepared(view.id, view.revision);
    expect(plan.typePatch).toBeUndefined();
    expect(plan.typeBaseline).toBeUndefined();
    const result = await s.executor.execute(plan);
    expect(result.items.filter(i => i.status === 'applied')).toHaveLength(5);
    expect(s.vault.config.has('types.json')).toBe(false);

    // B04: frontmatter dedupes target x keeping earliest and preserving unrelated duplicate `other`, body becomes `#x #x`.
    expect(s.vault.frontmatter('Cases/Branch/B04.md').tags).toEqual(['x', 'other', 'other']);
    expect((await s.vault.readText('Cases/Branch/B04.md')).trimEnd().endsWith('#x #x')).toBe(true);

    // B01: #a/bc untouched, #A/B -> #x, tags -> [x, x/c].
    expect(s.vault.frontmatter('Cases/Branch/B01.md').tags).toEqual(['x', 'x/c']);
    expect(await s.vault.readText('Cases/Branch/B01.md')).toContain('#x #a/bc');

    // B02: body multi-op on same line -> `#x/c #x/c`.
    const b02Preview = view.items.find(i => i.path === 'Cases/Branch/B02.md')!;
    expect(b02Preview.diffs.find(d => d.label === 'body')).toMatchObject({ before: '#a/b/c #a/b/c', after: '#x/c #x/c' });
    expect(await s.vault.readText('Cases/Branch/B02.md')).toContain('#x/c #x/c');

    // B06 protected syntax byte-identical.
    expect(await s.vault.readText('Cases/Branch/B06.md')).toBe(b06Before);

    // Post-migration tree counts: x direct 3, x/c direct 4, x/d direct 1, x branch 5.
    const postTree = buildTagTree(s.vault.getMarkdownFiles().map(f => s.vault.meta(f.path)));
    expect(postTree.nodes.get('x')!.directPaths.length).toBe(3);
    expect(postTree.nodes.get('x/c')!.directPaths.length).toBe(4);
    expect(postTree.nodes.get('x/d')!.directPaths.length).toBe(1);
    expect(postTree.nodes.get('x')!.branchPaths.length).toBe(5);

    // Undo restores everything byte-for-byte.
    const undo = await s.restore(result.transactionId);
    expect(undo.complete).toBe(true);
    expect(s.vault.frontmatter('Cases/Branch/B04.md').tags).toEqual(['x', 'a/b', 'x', 'other', 'other']);
  });

  it('TC-B02: virtual parent migrates descendants (B05 #virtual/leaf -> #new/leaf)', async () => {
    const s = batchServices();
    loadBranchFixtures(s.vault);
    const plan = await s.prepare({ kind: 'migrateTagBranch', from: '#virtual', to: '#new', includeDescendants: true }, BRANCH_SCOPE);
    expect(plan.changes.map(c => c.path)).toEqual(['Cases/Branch/B05.md']);
    await s.executor.execute(plan);
    expect(await s.vault.readText('Cases/Branch/B05.md')).toBe('#new/leaf #a/bc\n');
  });

  it('TC-B03 & TC-X04: preserves Unicode original-case suffix even when lowercase changes string length', async () => {
    const s = batchServices();
    s.vault.setText('u.md', '---\ntags:\n  - İstanbul/KeepCase/Ü\n---\n#İstanbul/KeepCase/Ü\n');
    const plan = await s.prepare({ kind: 'migrateTagBranch', from: '#İstanbul', to: '#Target', includeDescendants: true });
    await s.executor.execute(plan);
    expect(s.vault.frontmatter('u.md').tags).toEqual(['Target/KeepCase/Ü']);
    expect(await s.vault.readText('u.md')).toContain('#Target/KeepCase/Ü');
  });

  it('TC-B05 & TC-X13: rejects descendant targets, empty segments, incomplete tokens (#x~y, #~x), and handles ancestor overlap once', async () => {
    expect(isCompleteTagToken('#x/y')).toBe(true);
    expect(isCompleteTagToken('#x~y')).toBe(false);
    expect(isCompleteTagToken('#~x')).toBe(false);
    expect(isCompleteTagToken('#123')).toBe(false);
    expect(() => validateTagPath('/a')).toThrow('tag-path-invalid');
    expect(() => validateTagPath('a/')).toThrow('tag-path-invalid');
    expect(() => validateTagPath('a//b')).toThrow('tag-path-invalid');
    expect(() => validateTagPath('#x~y')).toThrow('tag-path-invalid');
    expect(() => validateTagPath('#~x')).toThrow('tag-path-invalid');
    expect(() => validateOperation({ kind: 'migrateTagBranch', from: '#a/b', to: '#a/b/c', includeDescendants: true })).toThrow('tag-descendant-target');

    const s = batchServices();
    s.vault.setText('same.md', '#a/b\n');
    const sameView = await s.preview({ kind: 'migrateTagBranch', from: '#a/b', to: '#A/B', includeDescendants: true });
    expect(sameView.summary.execute).toBe(0);
    expect(sameView.items[0].reason).toBe('already-equal');

    // Ancestor overlap: #a/b/b -> #a/b happens once and flags overlap.
    const s2 = batchServices();
    s2.vault.setText('overlap.md', '---\ntags: [a/b/b]\n---\n#a/b/b\n');
    const ovView = await s2.preview({ kind: 'migrateTagBranch', from: '#a/b', to: '#a', includeDescendants: true });
    expect(ovView.tagBranchSummary!.overlap).toBe(true);
    const ovPlan = s2.planner.getPrepared(ovView.id, ovView.revision);
    await s2.executor.execute(ovPlan);
    expect(s2.vault.frontmatter('overlap.md').tags).toEqual(['a/b']);
    expect(await s2.vault.readText('overlap.md')).toContain('#a/b');

    // Injected body re-parse failure / token truncation blocks note with tag-semantics-changed (process=0).
    const s3 = batchServices();
    s3.vault.setText('trunc.md', '#a/b\n');
    const origReadBound = s3.vault.readBoundTags.bind(s3.vault);
    let calls = 0;
    s3.vault.readBoundTags = async (path, source) => {
      calls++;
      if (calls === 2) return { ok: true, bodyTags: [{ tag: '#x', start: 0, end: 1 }] }; // simulated truncation
      return origReadBound(path, source);
    };
    const truncView = await s3.preview({ kind: 'migrateTagBranch', from: '#a/b', to: '#x', includeDescendants: false });
    expect(truncView.summary.execute).toBe(0);
    expect(truncView.items[0].state).toBe('blocked');
    expect(truncView.items[0].reason).toBe('tag-semantics-changed');
    expect(s3.vault.noteWrites).toBe(0);

    // Legacy renameTag journal entry still decodes with original rules.
    const before = '#old\n';
    const legacyTx = JSON.stringify({
      schemaVersion: 2,
      transactionId: 'tx_legacy_tag',
      planId: 'pc_legacy_tag',
      createdAt: 1,
      operation: { kind: 'renameTag', from: '#old', to: '#x~y' },
      scope: allNotesScope(),
      scopeSummary: { base: { kind: 'all' }, conditions: [], matched: 1, manual: 0, effective: 1, unknown: 0 },
      entries: [{ path: 'a.md', beforeContent: before, beforeHash: await sha256Hex(before), expectedAfterHash: await sha256Hex('#x~y\n') }],
      skipped: [],
      stateBudgetBytes: 1024,
    });
    const decoded = await decodeJournal(legacyTx, null, 'tx_legacy_tag', sha256Hex);
    expect(decoded.kind).toBe('v2');
  });

  it('TC-B06: preserves out-of-scope, globally excluded, manually excluded, deselected notes and independent descendant switches', async () => {
    const s = batchServices();
    loadBranchFixtures(s.vault);
    s.vault.setText('Outside/out.md', '#a/b\n');
    s.vault.setText('Excluded/ex.md', '#a/b\n');
    s.settings.excludeGlobs = ['Excluded/**'];

    const beforeOut = await sha256Hex(await s.vault.readText('Outside/out.md'));
    const beforeEx = await sha256Hex(await s.vault.readText('Excluded/ex.md'));
    const beforeB02 = await sha256Hex(await s.vault.readText('Cases/Branch/B02.md'));
    const beforeB03 = await sha256Hex(await s.vault.readText('Cases/Branch/B03.md'));

    // Scope has tag condition with includeDescendants=true, while action has includeDescendants=false!
    const scope: ScopeQuery = {
      base: { kind: 'folder', path: 'Cases/Branch', includeSubfolders: true },
      conditions: [{ id: 'c1', kind: 'tag', tag: '#a', operator: 'contains', includeDescendants: true }],
      manuallyExcludedPaths: ['Cases/Branch/B02.md'],
    };
    const view = await s.preview({ kind: 'migrateTagBranch', from: '#a/b', to: '#x', includeDescendants: false }, scope);
    expect(view.items.some(i => i.path === 'Cases/Branch/B02.md')).toBe(false);
    // B03 has #a/b/d, matched scope (descendants=true) but exact action does NOT rewrite it!
    expect(view.items.find(i => i.path === 'Cases/Branch/B03.md')!.state).toBe('noop');

    // Deselect B04 too.
    const b04 = view.items.find(i => i.path === 'Cases/Branch/B04.md')!;
    const revised = await s.planner.revisePreview(view.id, view.revision, [{ path: b04.path, beforeHash: b04.decision.beforeHash, selected: false }]);
    const beforeB04 = await sha256Hex(await s.vault.readText('Cases/Branch/B04.md'));

    const plan = s.planner.getPrepared(revised.id, revised.revision);
    await s.executor.execute(plan);

    expect(await sha256Hex(await s.vault.readText('Outside/out.md'))).toBe(beforeOut);
    expect(await sha256Hex(await s.vault.readText('Excluded/ex.md'))).toBe(beforeEx);
    expect(await sha256Hex(await s.vault.readText('Cases/Branch/B02.md'))).toBe(beforeB02);
    expect(await sha256Hex(await s.vault.readText('Cases/Branch/B03.md'))).toBe(beforeB03);
    expect(await sha256Hex(await s.vault.readText('Cases/Branch/B04.md'))).toBe(beforeB04);
  });

  it('TC-X15: reports outside-scope, globally/manually excluded index collisions and unknown coverage without extra readText', async () => {
    const s = batchServices();
    s.vault.setText('Books/source.md', '#a/b\n');
    s.vault.setText('Projects/existing.md', '#x\n');
    s.vault.setText('Excluded/existing.md', '#x\n');
    s.settings.excludeGlobs = ['Excluded/**'];

    // Build full raw snapshot containing ALL files (including Excluded).
    const snap = s.snapshot();
    // Ensure raw snapshot.files has Excluded too (just like VaultIndexer.publish sets snapshot.files = new Map(this.files)).
    expect(snap.files.has('Excluded/existing.md')).toBe(true);

    const readPaths: string[] = [];
    const origRead = s.vault.readText.bind(s.vault);
    s.vault.readText = async path => { readPaths.push(path); return origRead(path); };

    const booksScope: ScopeQuery = {
      base: { kind: 'folder', path: 'Books', includeSubfolders: true },
      conditions: [],
      manuallyExcludedPaths: [],
    };
    const view = await s.planner.createPreview({
      operation: { kind: 'migrateTagBranch', from: '#a/b', to: '#x', includeDescendants: false },
      scope: booksScope,
    });

    // Zero readText calls outside Books/!
    expect(readPaths).toEqual(['Books/source.md']);
    const collisions = view.tagBranchSummary!.collisions;
    expect(collisions.indexUnavailable).toBe(false);
    expect(collisions.freshCheckedPaths).toEqual(['Books/source.md']);
    expect(collisions.indexedOnlyCheckedPaths).toEqual(['Excluded/existing.md', 'Projects/existing.md']);
    expect(collisions.unknownPaths).toEqual([]);
    expect(collisions.matches).toEqual([{
      targetId: 'x',
      freshPaths: [],
      indexedOtherPaths: ['Excluded/existing.md', 'Projects/existing.md'],
    }]);

    // Add an unindexed file after snapshot + a modified-since-snapshot file -> must appear in unknownPaths.
    s.vault.setText('Unindexed/new.md', '#x\n');
    s.vault.setText('Projects/existing.md', '#x #more\n'); // mtime advanced beyond snapshot!
    const viewWithUnknown = await s.planner.createPreview({
      operation: { kind: 'migrateTagBranch', from: '#a/b', to: '#x', includeDescendants: false },
      scope: booksScope,
    });
    const unkPaths = viewWithUnknown.tagBranchSummary!.collisions.unknownPaths.map(u => u.path);
    expect(unkPaths).toEqual(['Projects/existing.md', 'Unindexed/new.md']);

    // Manual exclusion variant: Books/manual.md is manually excluded but still reported via index collision.
    const sManual = batchServices();
    sManual.vault.setText('Books/source.md', '#a/b\n');
    sManual.vault.setText('Books/manual.md', '#x\n');
    sManual.snapshot();
    const manualScope: ScopeQuery = {
      base: { kind: 'folder', path: 'Books', includeSubfolders: true },
      conditions: [],
      manuallyExcludedPaths: ['Books/manual.md'],
    };
    const manualView = await sManual.planner.createPreview({
      operation: { kind: 'migrateTagBranch', from: '#a/b', to: '#x', includeDescendants: false },
      scope: manualScope,
    });
    expect(manualView.tagBranchSummary!.collisions.matches[0].indexedOtherPaths).toEqual(['Books/manual.md']);

    // Missing snapshot marks indexUnavailable=true.
    const sNoSnap = batchServices();
    sNoSnap.vault.setText('Books/source.md', '#a/b\n');
    sNoSnap.vault.setText('Projects/existing.md', '#x\n');
    const noSnapView = await sNoSnap.planner.createPreview({
      operation: { kind: 'migrateTagBranch', from: '#a/b', to: '#x', includeDescendants: false },
      scope: booksScope,
    });
    expect(noSnapView.tagBranchSummary!.collisions.indexUnavailable).toBe(true);
    expect(noSnapView.tagBranchSummary!.collisions.unknownPaths.map(u => u.path)).toContain('Projects/existing.md');

    // ScopeService remains untouched.
    const scopeResult = await new ScopeService(() => s.settings).evaluate(booksScope, snap, { requestId: 1 });
    expect(scopeResult.effectivePaths).toEqual(['Books/source.md']);
  });

  it('Review #3: refreshValidity excludes stale in-scope captures from fresh collisions and ignores deleted snapshot files', async () => {
    const s = batchServices();
    s.vault.setText('Books/a.md', '#a/b\n');
    s.vault.setText('Books/target.md', '#x\n');
    s.vault.setText('Projects/deleted.md', '#x\n');
    s.snapshot();

    const booksScope: ScopeQuery = {
      base: { kind: 'folder', path: 'Books', includeSubfolders: true },
      conditions: [],
      manuallyExcludedPaths: [],
    };
    const v1 = await s.planner.createPreview({
      operation: { kind: 'migrateTagBranch', from: '#a/b', to: '#x', includeDescendants: false },
      scope: booksScope,
    });
    expect(v1.tagBranchSummary!.collisions.matches).toEqual([{
      targetId: 'x',
      freshPaths: ['Books/target.md'],
      indexedOtherPaths: ['Projects/deleted.md'],
    }]);

    // Edit in-scope target note to remove #x, and delete out-of-scope file from vault while snapshot still holds it.
    s.vault.setText('Books/target.md', '#other\n');
    s.vault.files.delete('Projects/deleted.md');

    const v2 = await s.planner.refreshValidity(v1.id, v1.revision);
    const collisions = v2.tagBranchSummary!.collisions;
    expect(collisions.freshCheckedPaths).toEqual(['Books/a.md']);
    expect(collisions.unknownPaths).toContainEqual({ path: 'Books/target.md', reason: 'file-stale' });
    expect(collisions.indexedOnlyCheckedPaths).toEqual([]);
    expect(collisions.matches).toEqual([]);
  });

  it('Review #4: pure-numeric virtual parent (#2026 from #2026/notes) can migrate descendants while rejecting non-tag direct targets', async () => {
    const s = batchServices();
    s.vault.setText('year.md', '---\ntags:\n  - 2026/notes\n---\n#2026/notes\n');
    const tree = buildTagTree([s.vault.meta('year.md')]);
    expect(tree.nodes.get('2026')).toMatchObject({ virtual: true, displayTag: '#2026', directPaths: [], branchPaths: ['year.md'] });

    // Migrate virtual parent #2026 -> #archive/2026
    const plan = await s.prepare({ kind: 'migrateTagBranch', from: '#2026', to: '#archive/2026', includeDescendants: true });
    expect(plan.changes).toHaveLength(1);
    await s.executor.execute(plan);
    expect(s.vault.frontmatter('year.md').tags).toEqual(['archive/2026/notes']);
    expect(await s.vault.readText('year.md')).toContain('#archive/2026/notes');

    // Also supports #2026 -> #2027 where actual written tag #2027/notes is a valid complete tag.
    const s2 = batchServices();
    s2.vault.setText('year.md', '---\ntags:\n  - 2026/notes\n---\n#2026/notes\n');
    const plan2 = await s2.prepare({ kind: 'migrateTagBranch', from: '#2026', to: '#2027', includeDescendants: true });
    await s2.executor.execute(plan2);
    expect(s2.vault.frontmatter('year.md').tags).toEqual(['2027/notes']);

    // Direct exact rename to/from pure-numeric #2026 is still rejected, and real tag -> #2027 blocks cleanly.
    expect(() => validateOperation({ kind: 'migrateTagBranch', from: '#2026', to: '#archive/2026', includeDescendants: false })).toThrow('tag-path-invalid');
    expect(() => validateOperation({ kind: 'migrateTagBranch', from: '#a/b', to: '#2026', includeDescendants: false })).toThrow('tag-path-invalid');
    const s3 = batchServices();
    s3.vault.setText('real.md', '#a/b\n');
    const badTargetView = await s3.preview({ kind: 'migrateTagBranch', from: '#a/b', to: '#2026', includeDescendants: true });
    expect(badTargetView.summary.execute).toBe(0);
    expect(badTargetView.items[0].state).toBe('blocked');
    expect(badTargetView.items[0].reason).toBe('tag-path-invalid');
  });

  it('Re-review #1: rebuilding a retry preview preserves the retry path whitelist and never re-adds succeeded overlapping notes', async () => {
    const s = batchServices();
    s.vault.setText('ok.md', '---\ntags: [a/b/b]\n---\n#a/b/b\n');
    s.vault.setText('fail.md', '---\ntags: [a/b/b]\n---\n#a/b/b\n');

    const op: MigrateTagBranchOperation = { kind: 'migrateTagBranch', from: '#a/b', to: '#a', includeDescendants: true };
    const plan = await s.prepare(op);
    const origProcess = s.vault.processText.bind(s.vault);
    s.vault.processText = async (path, transform) => {
      if (path === 'fail.md') throw new Error('temp-fail');
      return origProcess(path, transform);
    };
    const res = await s.executor.execute(plan);
    expect(res.items.find(i => i.path === 'ok.md')!.status).toBe('applied');
    expect(res.items.find(i => i.path === 'fail.md')!.status).toBe('failed');
    expect(s.vault.frontmatter('ok.md').tags).toEqual(['a/b']);
    const okAfterFirst = await s.vault.readText('ok.md');

    s.vault.processText = origProcess;
    await s.coordinator.initialize();
    const retryView = await s.coordinator.retry(res.transactionId, 'failed');
    expect(retryView.items.map(i => i.path)).toEqual(['fail.md']);

    // Rebuilding the retry preview MUST preserve the restricted path whitelist (`fail.md` only).
    const rebuilt = await s.planner.recreate(retryView.id, false);
    expect(rebuilt.items.map(i => i.path)).toEqual(['fail.md']);
    expect(rebuilt.retryOf).toBe(res.transactionId);

    await s.executor.execute(s.planner.getPrepared(rebuilt.id, rebuilt.revision));
    // `ok.md` was NOT rewritten to `#a`; `fail.md` is now migrated once to `#a/b`.
    expect(await s.vault.readText('ok.md')).toBe(okAfterFirst);
    expect(s.vault.frontmatter('fail.md').tags).toEqual(['a/b']);
  });

  it('Re-review #2: legacy renameTag #old -> #x~y journal stays readable/recoverable, while retry enforces strict tag validation', async () => {
    const s = batchServices();
    const before = '---\ntags:\n  - old\n---\n#old\n';
    s.vault.setText('a.md', before);
    const txId = 'tx_legacy_tilde';
    const tx = {
      schemaVersion: 2 as const,
      transactionId: txId,
      planId: 'pc_legacy_tilde',
      createdAt: 100,
      operation: { kind: 'renameTag' as const, from: '#old', to: '#x~y' },
      scope: allNotesScope(),
      scopeSummary: { base: { kind: 'all' as const }, conditions: [], matched: 1, manual: 0, effective: 1, unknown: 0 },
      entries: [{ path: 'a.md', beforeContent: before, beforeHash: await sha256Hex(before), expectedAfterHash: await sha256Hex('---\ntags:\n  - x~y\n---\n#x~y\n') }],
      skipped: [],
      stateBudgetBytes: 2048,
    };
    const state = {
      schemaVersion: 2 as const,
      transactionId: txId,
      revision: 1,
      updatedAt: 101,
      execution: 'partial' as const,
      recovery: 'none' as const,
      entries: [{ path: 'a.md', execution: 'failed' as const, recovery: 'none' as const, reason: 'write-failed' as const }],
      typeExecution: 'none' as const,
      typeRecovery: 'none' as const,
    };
    await s.storage.prepare(tx, state);
    await s.coordinator.initialize();

    // Still readable and recovery previewable.
    const loaded = await s.journal.get(txId);
    expect(loaded.kind).toBe('v2');
    const recovery = await s.undo.preview(txId);
    expect(recovery.items[0].kind).toBe('not-applied');

    // Retrying to create new writes MUST reject `#x~y` with `tag-path-invalid`.
    await expect(s.coordinator.retry(txId, 'failed')).rejects.toThrow('tag-path-invalid');
    expect(s.vault.noteWrites).toBe(0);
    expect(await s.vault.readText('a.md')).toBe(before);
  });
});
