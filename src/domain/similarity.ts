import type { DuplicateGroup, DuplicateReason, PropertyStat, TagStat } from './models';
import { differsOnlyByCase, differsOnlyBySeparator, normalizeKey, normalizeTag, singularize, stripHash } from './normalize';

export interface DuplicateOptions {
  similarityThreshold: number;
  includeSimilarity?: boolean;
}

/** Levenshtein distance with an optional cap; returns `cap + 1` once exceeded. */
export function levenshtein(a: string, b: string, cap = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = new Array<number>(cols);
  let current = new Array<number>(cols);
  for (let j = 0; j < cols; j += 1) previous[j] = j;
  for (let i = 1; i < rows; i += 1) {
    current[0] = i;
    let best = current[0];
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (current[j] < best) best = current[j];
    }
    if (best > cap) return cap + 1;
    [previous, current] = [current, previous];
  }
  return previous[cols - 1];
}

export function similarityScore(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

function pairReasons(a: string, b: string, baseOf: (value: string) => string): Set<DuplicateReason> {
  const reasons = new Set<DuplicateReason>();
  if (differsOnlyByCase(a, b)) reasons.add('case');
  if (differsOnlyBySeparator(a, b)) reasons.add('separator');
  const na = normalizeTag(a);
  const nb = normalizeTag(b);
  if (na !== nb && baseOf(a) === baseOf(b)) reasons.add('plural');
  return reasons;
}

function groupScore(members: string[], normalize: (value: string) => string): number {
  let min = 1;
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const score = similarityScore(normalize(members[i]), normalize(members[j]));
      if (score < min) min = score;
    }
  }
  return Number.isFinite(min) ? Number(min.toFixed(2)) : 1;
}

function buildGroup(kind: 'tag' | 'property', members: string[], reason: DuplicateReason[], score: number): DuplicateGroup {
  const sorted = [...members].sort((a, b) => a.localeCompare(b));
  return {
    id: `dup:${kind}:${sorted.join('|')}`,
    kind,
    members: sorted,
    reason,
    score,
    ignored: false,
  };
}

function collectGroups(
  kind: 'tag' | 'property',
  values: string[],
  baseOf: (value: string) => string,
  normalize: (value: string) => string,
  threshold: number,
  includeSimilarity: boolean,
): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const byBase = new Map<string, string[]>();
  for (const value of values) {
    const base = baseOf(value);
    if (!base) continue;
    const bucket = byBase.get(base);
    if (bucket) bucket.push(value);
    else byBase.set(base, [value]);
  }
  const grouped = new Set<string>();
  for (const members of byBase.values()) {
    if (members.length < 2) continue;
    const reasons = new Set<DuplicateReason>();
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        for (const reason of pairReasons(members[i], members[j], baseOf)) reasons.add(reason);
      }
    }
    if (reasons.size === 0) reasons.add('similarity');
    const score = groupScore(members, normalize);
    groups.push(buildGroup(kind, members, [...reasons], score));
    for (const member of members) grouped.add(member);
  }

  if (includeSimilarity && groups.length < 200) {
    const remaining = values.filter(value => !grouped.has(value) && normalize(value).length >= 5);
    const byLength = new Map<number, string[]>();
    for (const value of remaining) {
      const length = normalize(value).length;
      const bucket = byLength.get(length) ?? [];
      bucket.push(value);
      byLength.set(length, bucket);
    }
    const seen = new Set<string>();
    for (const [length, bucket] of byLength) {
      const candidates = [...bucket, ...(byLength.get(length + 1) ?? [])];
      for (let i = 0; i < candidates.length; i += 1) {
        for (let j = i + 1; j < candidates.length; j += 1) {
          const a = candidates[i];
          const b = candidates[j];
          if (a === b) continue;
          const distance = levenshtein(normalize(a), normalize(b), 1);
          if (distance > 1) continue;
          const score = Number(similarityScore(normalize(a), normalize(b)).toFixed(2));
          if (score < threshold) continue;
          const key = [a, b].sort().join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          groups.push(buildGroup(kind, [a, b], ['similarity'], score));
        }
      }
    }
  }

  return groups;
}

export function detectTagDuplicates(tags: TagStat[], options: DuplicateOptions): DuplicateGroup[] {
  const values = tags.map(tag => tag.tag).filter(tag => stripHash(tag).length > 0);
  return collectGroups('tag', values, raw => singularize(normalizeTag(raw)), normalizeTag, options.similarityThreshold, options.includeSimilarity ?? true);
}

export function detectPropertyDuplicates(properties: PropertyStat[], options: DuplicateOptions): DuplicateGroup[] {
  const values = properties.filter(prop => !prop.isReserved).map(prop => prop.key);
  return collectGroups('property', values, raw => normalizeKey(raw), normalizeKey, options.similarityThreshold, options.includeSimilarity ?? true);
}
