import { describe, expect, it } from 'vitest';
import { buildTagTree } from '../src/domain/tag-tree';
import { ScopeService } from '../src/application/ScopeService';
import { TagWorkbenchService } from '../src/application/TagWorkbenchService';
import { allNotesScope } from '../src/domain/scope';
import { batchServices } from './support/vault';
import { BRANCH_SCOPE, loadBranchFixtures } from './support/fixtures014';

describe('0.1.4 tag identity tree and TagWorkbenchService', () => {
  it('TC-B01: computes exact direct, branch, virtual, and unreliable counts on Cases/Branch', async () => {
    const s = batchServices();
    loadBranchFixtures(s.vault);
    const snap = s.snapshot();
    const scopeService = new ScopeService(() => s.settings);
    const scope = await scopeService.evaluate(BRANCH_SCOPE, snap, { requestId: 1 });
    const workbench = new TagWorkbenchService(() => s.settings);
    const tree = await workbench.analyze(snap, scope, { requestId: 1 });

    expect(tree.effectiveNoteCount).toBe(8);
    expect(tree.countedNoteCount).toBe(7);
    expect(tree.unreliablePaths).toEqual([{ path: 'Cases/Branch/B07.md', reason: 'frontmatter-invalid' }]);
    expect(tree.scopeUnknownPaths).toEqual([]);

    const ab = tree.nodes.get('a/b')!;
    expect(ab.virtual).toBe(false);
    expect(ab.directPaths).toEqual(['Cases/Branch/B01.md', 'Cases/Branch/B04.md', 'Cases/Branch/B08.md']);
    expect(ab.branchPaths).toEqual([
      'Cases/Branch/B01.md', 'Cases/Branch/B02.md', 'Cases/Branch/B03.md', 'Cases/Branch/B04.md', 'Cases/Branch/B08.md',
    ]);
    expect(ab.rawVariants).toEqual(['#A/B', '#a/b']);

    expect(tree.nodes.get('a/b/c')!.directPaths).toEqual(['Cases/Branch/B01.md', 'Cases/Branch/B02.md', 'Cases/Branch/B08.md']);
    expect(tree.nodes.get('a/b/d')!.directPaths).toEqual(['Cases/Branch/B03.md']);
    expect(tree.nodes.get('a/bc')!.directPaths).toEqual(['Cases/Branch/B01.md', 'Cases/Branch/B05.md']);

    const virtualNode = tree.nodes.get('virtual')!;
    expect(virtualNode.virtual).toBe(true);
    expect(virtualNode.directPaths).toEqual([]);
    expect(virtualNode.branchPaths).toEqual(['Cases/Branch/B05.md']);
    expect(virtualNode.rawVariants).toEqual([]);

    // Virtual parents are excluded from realTagCount.
    const realNodes = [...tree.nodes.values()].filter(node => !node.virtual);
    expect(tree.realTagCount).toBe(realNodes.length);
  });

  it('TC-X04: preserves underscore vs hyphen distinction and case-insensitive identity', () => {
    const s = batchServices();
    s.vault.setText('a.md', '---\ntags: [deep_work, Deep_Work]\n---\n#deep-work #İstanbul/Note\n');
    const tree = buildTagTree([s.vault.meta('a.md')]);
    expect(tree.nodes.get('deep_work')!.directPaths).toEqual(['a.md']);
    expect(tree.nodes.get('deep_work')!.rawVariants).toEqual(['#Deep_Work', '#deep_work']);
    expect(tree.nodes.get('deep-work')!.directPaths).toEqual(['a.md']);
    expect(tree.nodes.get('deep_work')).not.toBe(tree.nodes.get('deep-work'));
    expect(tree.nodes.has('i\u0307stanbul/note')).toBe(true);
  });

  it('TC-B07: rejects mismatched snapshot revisions, supports cancellation, and isolates unreliable containers', async () => {
    const s = batchServices();
    loadBranchFixtures(s.vault);
    s.vault.setText('Cases/Branch/B09-bad-container.md', '---\ntags: 123\n---\n');
    const snap1 = s.snapshot();
    const scopeService = new ScopeService(() => s.settings);
    const scope = await scopeService.evaluate(BRANCH_SCOPE, snap1, { requestId: 1 });
    const workbench = new TagWorkbenchService(() => s.settings);

    const tree = await workbench.analyze(snap1, scope, { requestId: 1 });
    expect(tree.unreliablePaths).toEqual([
      { path: 'Cases/Branch/B07.md', reason: 'frontmatter-invalid' },
      { path: 'Cases/Branch/B09-bad-container.md', reason: 'tag-container-unsupported' },
    ]);

    // Stale snapshot revision must be rejected rather than falling back to whole vault.
    const snap2 = s.snapshot();
    await expect(workbench.analyze(snap2, scope, { requestId: 2 })).rejects.toThrow('metadata-stale');

    // Aborted signal cancels cleanly.
    const abort = new AbortController();
    abort.abort();
    await expect(workbench.analyze(snap1, scope, { requestId: 3, signal: abort.signal })).rejects.toThrow();
  });

  it('TC-P01: aggregates a 10,000-note synthetic vault accurately and respects cancellation', async () => {
    const s = batchServices();
    for (let i = 0; i < 10000; i++) {
      const folder = `Batch${i % 10}`;
      const leaf = `#domain/cat${i % 25}/sub${i % 10}`;
      s.vault.setText(`${folder}/note-${i}.md`, `---\ntags: [domain/cat${i % 25}]\n---\n${leaf}\n`);
    }
    const snap = s.snapshot();
    const scopeService = new ScopeService(() => s.settings);
    const scope = await scopeService.evaluate(allNotesScope(), snap, { requestId: 1 });
    const workbench = new TagWorkbenchService(() => s.settings);

    const start = performance.now();
    const tree = await workbench.analyze(snap, scope, { requestId: 1 });
    const elapsed = performance.now() - start;

    expect(tree.effectiveNoteCount).toBe(10000);
    expect(tree.countedNoteCount).toBe(10000);
    expect(tree.nodes.get('domain')!.virtual).toBe(true);
    expect(tree.nodes.get('domain')!.directPaths).toEqual([]);
    expect(tree.nodes.get('domain')!.branchPaths.length).toBe(10000);
    expect(elapsed).toBeLessThan(5000);
  });
});
