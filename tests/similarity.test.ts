import { describe, expect, it } from 'vitest';
import type { TagStat } from '../src/domain/models';
import { detectTagDuplicates, levenshtein, similarityScore } from '../src/domain/similarity';

function tag(value: string, count = 1): TagStat {
  return { tag: value, normalized: value.replace(/^#/, ''), fileCount: count, origin: 'body', samplePaths: [] };
}

const options = { similarityThreshold: 0.8 };

describe('levenshtein / similarityScore', () => {
  it('computes distance', () => {
    expect(levenshtein('book', 'books')).toBe(1);
    expect(levenshtein('book', 'book')).toBe(0);
  });
  it('bounds distance when a cap is given', () => {
    expect(levenshtein('book', 'application', 1)).toBeGreaterThan(1);
  });
  it('computes similarity', () => {
    expect(similarityScore('book', 'book')).toBe(1);
  });
});

describe('detectTagDuplicates', () => {
  it('groups case variants', () => {
    const groups = detectTagDuplicates([tag('#book'), tag('#Book')], options);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members).toEqual(expect.arrayContaining(['#Book', '#book']));
    expect(groups[0]!.members).toHaveLength(2);
    expect(groups[0]!.reason).toContain('case');
  });
  it('groups singular/plural', () => {
    const groups = detectTagDuplicates([tag('#idea'), tag('#ideas')], options);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.reason).toContain('plural');
  });
  it('groups separator variants', () => {
    const groups = detectTagDuplicates([tag('#deep work'), tag('#deep-work')], options);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.reason).toContain('separator');
  });
  it('does not group unrelated tags', () => {
    const groups = detectTagDuplicates([tag('#apple'), tag('#application')], options);
    expect(groups).toHaveLength(0);
  });
  it('keeps nested tags with different parents apart', () => {
    const groups = detectTagDuplicates([tag('#a/x'), tag('#b/x')], options);
    expect(groups).toHaveLength(0);
  });
});
