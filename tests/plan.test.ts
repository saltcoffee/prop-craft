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
    expect(change!.edits[0]!.fmOp!.delete).toContain('author');
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

  it('flags a scalar conflict under merge-list', () => {
    const change = planMergeProperty(meta('a.md', { from: 'a', to: 'b' }), 'from', 'to', 'merge-list');
    expect(change!.conflict).toBeDefined();
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
  it('rewrites inline positions and frontmatter tags, content edit first', () => {
    const tags: TagOccurrence[] = [
      { tag: '#阅读', normalized: '阅读', origin: 'body', positions: [{ start: 10, end: 13 }] },
    ];
    const change = planRenameTag(meta('a.md', { tags: ['阅读', '方法论'] }, tags), '#阅读', '#读书');
    expect(change).not.toBeNull();
    expect(change!.edits[0]!.target).toBe('content');
    expect(change!.edits[0]!.textOps![0]).toMatchObject({ expect: '#阅读', replacement: '#读书' });
    expect(change!.afterFrontmatter.tags).toEqual(['读书', '方法论']);
  });

  it('returns null when the tag is absent', () => {
    expect(planRenameTag(meta('a.md', { tags: ['其它'] }), '#阅读', '#读书')).toBeNull();
  });
});
