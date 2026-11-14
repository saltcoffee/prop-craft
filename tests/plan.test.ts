import { describe, expect, it } from 'vitest';
import type { FileMeta, TagOccurrence } from '../src/domain/models';
import {
  planAddProperty, planDeleteProperty, planMergeProperty, planNormalizeDate, planRenameProperty, planRenameTag,
} from '../src/domain/plan';

function meta(path: string, frontmatter: Record<string, unknown>, tags: TagOccurrence[] = []): FileMeta {
  return {
    path,
    mtime: 0,
    hasValidFrontmatter: Object.keys(frontmatter).length > 0,
    frontmatterParseError: false,
    rawFrontmatter: frontmatter,
    properties: {},
    tags,
  };
}

describe('property planning', () => {
  it('renames a property key', () => {
    const change = planRenameProperty(meta('a.md', { author: 'x' }), 'author', 'creator');
    expect(change).not.toBeNull();
    expect(change!.afterFrontmatter.creator).toBe('x');
    expect(change!.afterFrontmatter.author).toBeUndefined();
  });

  it('merges into a missing target', () => {
    const change = planMergeProperty(meta('a.md', { from: 'a' }), 'from', 'to', 'keep-target');
    expect(change!.afterFrontmatter.to).toBe('a');
  });

  it('unions two lists when merging', () => {
    const change = planMergeProperty(meta('a.md', { from: [1, 2], to: [2, 3] }), 'from', 'to', 'merge-list');
    const values = change!.afterFrontmatter.to as number[];
    expect([...values].sort()).toEqual([1, 2, 3]);
  });

  it('does not silently fall back to keep-target for scalar merge-list', () => {
    const change = planMergeProperty(meta('a.md', { from: 'a', to: 'b' }), 'from', 'to', 'merge-list');
    expect(change).toBeNull();
  });

  it('skips adding when the key exists and policy is skip', () => {
    const change = planAddProperty(meta('a.md', { status: 'done' }), 'status', 'todo', 'text', 'skip');
    expect(change).toBeNull();
  });

  it('adds a new property', () => {
    const change = planAddProperty(meta('a.md', {}), 'status', 'todo', 'text', 'skip');
    expect(change!.afterFrontmatter.status).toBe('todo');
  });

  it('deletes a property', () => {
    const change = planDeleteProperty(meta('a.md', { junk: 1 }), 'junk');
    expect(change!.afterFrontmatter.junk).toBeUndefined();
  });
});

describe('date planning', () => {
  it('normalizes a text date', () => {
    const change = planNormalizeDate(meta('a.md', { date: '2024/1/5' }), 'date', 'date', 'MDY');
    expect(change!.afterFrontmatter.date).toBe('2024-01-05');
  });
  it('returns null when nothing changes', () => {
    expect(planNormalizeDate(meta('a.md', { date: '2024-01-05' }), 'date', 'date', 'MDY')).toBeNull();
  });
  it('ignores non-string values', () => {
    expect(planNormalizeDate(meta('a.md', { date: 20240105 }), 'date', 'date', 'MDY')).toBeNull();
  });
});

describe('tag planning', () => {
  it.each([
    ['#Book', '#book'],
    ['#foo_bar', '#foo-bar'],
  ])('rewrites duplicate spellings %s to %s', (from, to) => {
    const tags: TagOccurrence[] = [{ tag: from, normalized: '', origin: 'both', positions: [{ start: 0, end: from.length }] }];
    const change = planRenameTag(meta('a.md', { tags: [from.slice(1)] }, tags), from, to)!;
    expect(change.afterFrontmatter.tags).toEqual([to.slice(1)]);
    expect(change.textOps[0]!.replacement).toBe(to);
  });

  it('preserves unrelated tag spellings, duplicates, and non-string entries', () => {
    const change = planRenameTag(meta('a.md', { tags: ['old', 'project_alpha', 'project-alpha', 'other', 'other', 7] }), '#old', '#new')!;
    expect(change.afterFrontmatter.tags).toEqual(['new', 'project_alpha', 'project-alpha', 'other', 'other', 7]);
  });

  it('matches case variants but preserves distinct separators', () => {
    const change = planRenameTag(meta('a.md', { tags: ['old_tag', 'old-tag', 'Old_tag'] }), '#old_tag', '#new')!;
    expect(change.afterFrontmatter.tags).toEqual(['new', 'old-tag']);
  });

  it('only deduplicates the merge destination', () => {
    const change = planRenameTag(meta('a.md', { tags: ['old', '#new', 'new', 'other', 'other'] }), '#old', '#new')!;
    expect(change.afterFrontmatter.tags).toEqual(['new', 'other', 'other']);
  });

  it('preserves unrelated separator variants in a comma-separated tags value', () => {
    const change = planRenameTag(meta('a.md', { tags: 'old, project_alpha, project-alpha' }), '#old', '#new')!;
    expect(change.afterFrontmatter.tags).toBe('new, project_alpha, project-alpha');
  });

  it('adds the hash prefix to a target entered without one', () => {
    const tags: TagOccurrence[] = [{ tag: '#old', normalized: 'old', origin: 'both', positions: [{ start: 0, end: 4 }] }];
    const change = planRenameTag(meta('a.md', { tags: ['old'] }, tags), '#old', 'new')!;
    expect(change.textOps[0]!.replacement).toBe('#new');
    expect(change.afterFrontmatter.tags).toEqual(['new']);
  });

  it.each(['', '#', 'new tag', '1234', '#new#tag', 'new:tag'])('does not plan an invalid tag target: %s', target => {
    expect(planRenameTag(meta('a.md', { tags: ['old'] }), '#old', target)).toBeNull();
  });

  it('rewrites inline positions and frontmatter tags, content edit first', () => {
    const tags: TagOccurrence[] = [
      { tag: '#阅读', normalized: '阅读', origin: 'body', positions: [{ start: 10, end: 13 }] },
    ];
    const change = planRenameTag(meta('a.md', { tags: ['阅读', '方法论'] }, tags), '#阅读', '#读书');
    expect(change).not.toBeNull();
    expect(change!.textOps[0]).toMatchObject({ expect: '#阅读', replacement: '#读书' });
    expect(change!.afterFrontmatter.tags).toEqual(['读书', '方法论']);
  });

  it('returns null when the tag is absent', () => {
    expect(planRenameTag(meta('a.md', { tags: ['其它'] }), '#阅读', '#读书')).toBeNull();
  });
});
