import { describe, expect, it, vi } from 'vitest';
import { planAddProperty, planRenameProperty, planRenameTag } from '../src/domain/plan';
import { ChangePlanner } from '../src/application/ChangePlanner';
import { SnapshotStore } from '../src/application/SnapshotStore';
import { emptySnapshot } from '../src/application/VaultIndexer';
import { DEFAULT_SETTINGS } from '../src/settings-model';
import { batchServices, changePlan } from './support/vault';

describe('change execution', () => {
  it('plans and executes a tag merge with a target entered without a hash', async () => {
    const { vault, executor } = batchServices();
    vault.add('a.md', { tags: ['old', 'project_alpha', 'project-alpha'] }, '#old');
    const store = new SnapshotStore();
    const snapshot = emptySnapshot();
    snapshot.files.set('a.md', vault.meta('a.md'));
    store.set(snapshot);
    const planner = new ChangePlanner(vault, store, () => DEFAULT_SETTINGS);
    const plan = planner.planMergeTag('#old', 'new');
    expect(plan.operation).toEqual({ kind: 'mergeTag', from: '#old', to: '#new' });
    const result = await executor.execute(plan);
    expect(result.succeeded).toEqual(['a.md']);
    expect(vault.frontmatter('a.md')).toEqual({ tags: ['new', 'project_alpha', 'project-alpha'] });
    expect(await vault.readText('a.md')).toContain('\n#new');
  });

  it('applies a current property plan and records its original content', async () => {
    const { vault, executor, journal } = batchServices();
    vault.add('a.md', { author: 'Alice', untouched: ['x'] }, 'Body text');
    const before = await vault.readText('a.md');
    const change = planRenameProperty(vault.meta('a.md'), 'author', 'creator')!;
    const result = await executor.execute(changePlan([change]));
    expect(result.succeeded).toEqual(['a.md']);
    expect(vault.frontmatter('a.md')).toEqual({ creator: 'Alice', untouched: ['x'] });
    expect(await journal.get(result.transactionId)).toMatchObject({
      status: 'committed', entries: [{ beforeContent: before, state: 'applied', afterHash: expect.any(String) }],
    });
  });

  it.each([
    { author: 'New source value' },
    { author: 'Alice', creator: 'New target value' },
  ])('rejects a preview made before a file changed: %j', async frontmatter => {
    const { vault, executor } = batchServices();
    vault.add('a.md', { author: 'Alice' });
    const change = planRenameProperty(vault.meta('a.md'), 'author', 'creator')!;
    vault.setFrontmatter('a.md', frontmatter);
    const current = await vault.readText('a.md');
    const result = await executor.execute(changePlan([change]));
    expect(result.succeeded).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(await vault.readText('a.md')).toBe(current);
  });

  it.each([
    { author: 'New source value' },
    { author: 'Alice', creator: 'New target value' },
    {},
  ])('checks property values inside the write callback: %j', async frontmatter => {
    const { vault, executor } = batchServices();
    vault.add('a.md', { author: 'Alice' });
    const change = planRenameProperty(vault.meta('a.md'), 'author', 'creator')!;
    const process = vault.processFrontMatter.bind(vault);
    vi.spyOn(vault, 'processFrontMatter').mockImplementationOnce(async (path, fn) => {
      vault.setFrontmatter(path, frontmatter);
      await process(path, fn);
    });
    const result = await executor.execute(changePlan([change]));
    expect(result.failed).toHaveLength(1);
    expect(vault.frontmatter('a.md')).toEqual(frontmatter);
  });

  it('respects the skip policy if a property appears before the write callback', async () => {
    const { vault, executor } = batchServices();
    vault.add('a.md');
    const change = planAddProperty(vault.meta('a.md'), 'status', 'todo', 'text', 'skip')!;
    const process = vault.processFrontMatter.bind(vault);
    vi.spyOn(vault, 'processFrontMatter').mockImplementationOnce(async (path, fn) => {
      vault.setFrontmatter(path, { status: 'done' });
      await process(path, fn);
    });
    const result = await executor.execute(changePlan([change]));
    expect(result.failed).toHaveLength(1);
    expect(vault.frontmatter('a.md')).toEqual({ status: 'done' });
  });

  it('rejects stale property values even when the file mtime is unchanged', async () => {
    const { vault, executor } = batchServices();
    vault.add('a.md', { author: 'Alice' });
    const change = planRenameProperty(vault.meta('a.md'), 'author', 'creator')!;
    vault.setFrontmatter('a.md', { author: 'Bob' });
    vault.files.get('a.md')!.mtime = change.expectedMtime;
    const result = await executor.execute(changePlan([change]));
    expect(result.failed).toHaveLength(1);
    expect(vault.frontmatter('a.md')).toEqual({ author: 'Bob' });
  });

  it('rejects shifted tag positions rather than reporting a successful no-op', async () => {
    const { vault, executor } = batchServices();
    vault.add('a.md', {}, '#old');
    const meta = vault.meta('a.md');
    meta.tags[0]!.positions[0]!.start += 1;
    const change = planRenameTag(meta, '#old', '#new')!;
    const before = await vault.readText('a.md');
    const result = await executor.execute(changePlan([change]));
    expect(result.failed).toHaveLength(1);
    expect(await vault.readText('a.md')).toBe(before);
  });

  it('preserves content changed between validation and the text write callback', async () => {
    const { vault, executor } = batchServices();
    vault.add('a.md', {}, '#old');
    const change = planRenameTag(vault.meta('a.md'), '#old', '#new')!;
    const process = vault.processText.bind(vault);
    vi.spyOn(vault, 'processText').mockImplementationOnce(async (path, fn) => {
      vault.add(path, {}, 'User edit #old');
      await process(path, fn);
    });
    const result = await executor.execute(changePlan([change]));
    expect(result.failed).toHaveLength(1);
    expect(await vault.readText('a.md')).toContain('User edit #old');
  });

  it('keeps a partially written file undoable when its second edit fails', async () => {
    const { vault, executor, journal, undo } = batchServices();
    vault.add('a.md', { tags: ['old'] }, '#old');
    const before = await vault.readText('a.md');
    const change = planRenameTag(vault.meta('a.md'), '#old', '#new')!;
    vi.spyOn(vault, 'processFrontMatter').mockRejectedValueOnce(new Error('Write failed'));
    const result = await executor.execute(changePlan([change]));
    expect(result.failed).toHaveLength(1);
    expect(await journal.get(result.transactionId)).toMatchObject({ status: 'partial', entries: [{ state: 'applied' }] });
    expect((await undo.undo(result.transactionId)).restored).toEqual(['a.md']);
    expect(await vault.readText('a.md')).toBe(before);
  });

  it('writes and restores a concurrent batch', async () => {
    const { vault, executor, undo } = batchServices();
    const changes = Array.from({ length: 12 }, (_, index) => {
      const path = `${index}.md`;
      vault.add(path, {}, '#old');
      return planRenameTag(vault.meta(path), '#old', 'new')!;
    });
    const result = await executor.execute(changePlan(changes), { concurrency: 4 });
    expect(result.failed).toEqual([]);
    expect(result.succeeded).toHaveLength(12);
    expect((await undo.undo(result.transactionId)).restored).toHaveLength(12);
    for (const change of changes) expect(await vault.readText(change.path)).toContain('#old');
  });
});
