import { describe, expect, it } from 'vitest';
import { differsOnlyByCase, differsOnlyBySeparator, isValidTag, normalizeKey, normalizeTag, singularize } from '../src/domain/normalize';

describe('normalizeTag', () => {
  it('lowercases and strips #', () => {
    expect(normalizeTag('#Book')).toBe('book');
    expect(normalizeTag('#阅读')).toBe('阅读');
  });
  it('folds whitespace and underscore into dashes', () => {
    expect(normalizeTag('#deep work')).toBe('deep-work');
    expect(normalizeTag('#deep_work')).toBe('deep-work');
  });
});

describe('normalizeKey', () => {
  it('case-folds only', () => {
    expect(normalizeKey('Author')).toBe('author');
    expect(normalizeKey(' 作者 ')).toBe('作者');
  });
});

describe('tag input', () => {
  it.each(['#reading', 'my_tag', '项目/计划-1', '📚', 'y1984'])('accepts valid tag names: %s', tag => {
    expect(isValidTag(tag)).toBe(true);
  });
  it.each(['', '#', 'two words', '#1984', 'a#b', 'a:b'])('rejects invalid tag names: %s', tag => {
    expect(isValidTag(tag)).toBe(false);
  });
});

describe('singularize', () => {
  it('handles plural forms', () => {
    expect(singularize('stories')).toBe('story');
    expect(singularize('ideas')).toBe('idea');
  });
  it('does not touch words ending in ss or short words', () => {
    expect(singularize('glass')).toBe('glass');
    expect(singularize('bus')).toBe('bus');
  });
});

describe('difference classifiers', () => {
  it('detects case-only differences', () => {
    expect(differsOnlyByCase('#Book', '#book')).toBe(true);
    expect(differsOnlyByCase('#book', '#book')).toBe(false);
  });
  it('detects separator-only differences', () => {
    expect(differsOnlyBySeparator('#deep work', '#deep-work')).toBe(true);
  });
});
