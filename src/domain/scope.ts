import type { FileMeta } from './models';
import { isValidTag, tagIdentity } from './normalize';
import { OperationError } from './errors';

export type Scalar = string | number | boolean;
export type ScopeCondition =
  | { id: string; kind: 'tag'; tag: string; operator: 'contains' | 'not-contains'; includeDescendants: boolean }
  | { id: string; kind: 'property'; key: string; operator: 'exists' | 'missing' | 'empty' }
  | { id: string; kind: 'property'; key: string; operator: 'equals'; value: Scalar };
export interface ScopeQuery {
  base: { kind: 'all' } | { kind: 'folder'; path: string; includeSubfolders: boolean };
  conditions: readonly ScopeCondition[];
  manuallyExcludedPaths: readonly string[];
}
export type MatchResult = 'match' | 'no-match' | 'unknown';
export const allNotesScope = (): ScopeQuery => ({ base: { kind: 'all' }, conditions: [], manuallyExcludedPaths: [] });
export const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

export function isVaultPath(path: string): boolean {
  return Boolean(path) && !/^[/\\]|^[a-z]:/i.test(path) && !path.includes('\\')
    && !path.includes('\0') && path.split('/').every(part => Boolean(part) && part !== '.' && part !== '..');
}
export function isNotePath(path: string): boolean {
  return isVaultPath(path) && path.toLowerCase().endsWith('.md');
}
export function validateScope(query: ScopeQuery, folders: readonly string[]): ScopeQuery {
  if (!query || !Array.isArray(query.conditions) || !Array.isArray(query.manuallyExcludedPaths)) throw new OperationError('scope-invalid');
  if (query.base.kind === 'folder') {
    const path = query.base.path.replace(/\/$/, '');
    if (!isVaultPath(path) || !folders.includes(path) || typeof query.base.includeSubfolders !== 'boolean') throw new OperationError('scope-invalid');
    query = { ...query, base: { ...query.base, path } };
  } else if (query.base.kind !== 'all') throw new OperationError('scope-invalid');
  const ids = new Set<string>();
  for (const condition of query.conditions) {
    if (typeof condition.id !== 'string' || !condition.id || ids.has(condition.id)) throw new OperationError('scope-invalid');
    ids.add(condition.id);
    if (condition.kind === 'tag') {
      if (!isValidTag(condition.tag) || !['contains', 'not-contains'].includes(condition.operator)
        || typeof condition.includeDescendants !== 'boolean') throw new OperationError('scope-invalid');
    } else if (condition.kind === 'property') {
      if (typeof condition.key !== 'string' || !condition.key || !['exists', 'missing', 'empty', 'equals'].includes(condition.operator)) throw new OperationError('scope-invalid');
      if (condition.operator === 'equals' && !(['string', 'number', 'boolean'].includes(typeof condition.value))
        || condition.operator === 'equals' && typeof condition.value === 'number' && !Number.isFinite(condition.value)) throw new OperationError('scope-invalid');
    } else throw new OperationError('scope-invalid');
  }
  if (!query.manuallyExcludedPaths.every(path => typeof path === 'string' && isNotePath(path))) throw new OperationError('scope-invalid');
  return structuredClone(query);
}
export function inBase(path: string, base: ScopeQuery['base']): boolean {
  if (base.kind === 'all') return true;
  if (!path.startsWith(`${base.path}/`)) return false;
  return base.includeSubfolders || !path.slice(base.path.length + 1).includes('/');
}
export function matchScope(file: FileMeta, query: ScopeQuery): MatchResult {
  if (!inBase(file.path, query.base)) return 'no-match';
  let unknown = false;
  for (const condition of query.conditions) {
    if (file.metadataStatus === 'unavailable' || file.frontmatterParseError) { unknown = true; continue; }
    if (condition.kind === 'tag') {
      if (file.tagsComplete === false) { unknown = true; continue; }
      const target = tagIdentity(condition.tag);
      const contains = file.tags.some(tag => {
        const identity = tagIdentity(tag.tag);
        return identity === target || condition.includeDescendants && identity.startsWith(`${target}/`);
      });
      if (condition.operator === 'contains' ? !contains : contains) return 'no-match';
    } else {
      const fm = file.rawFrontmatter;
      const exists = hasOwn(fm, condition.key);
      const value = fm[condition.key];
      const matches = condition.operator === 'exists' ? exists
        : condition.operator === 'missing' ? !exists
          : condition.operator === 'empty' ? exists && (value === null || value === '' || Array.isArray(value) && value.length === 0)
            : condition.operator === 'equals' && exists && value === condition.value;
      if (!matches) return 'no-match';
    }
  }
  return unknown ? 'unknown' : 'match';
}
export interface ScopeSummary {
  base: ScopeQuery['base'];
  conditions: readonly ScopeCondition[];
  matched: number;
  manual: number;
  effective: number;
  unknown: number;
}
export interface ScopeResult {
  requestId: number;
  snapshotRevision: number;
  queryFingerprint: string;
  settingsFingerprint: string;
  candidatePaths: string[];
  matchedPaths: string[];
  noMatchPaths: string[];
  unknownPaths: string[];
  globallyExcludedPaths: string[];
  manuallyExcludedPaths: string[];
  effectivePaths: string[];
  reasons: Record<string, 'frontmatter-invalid' | 'metadata-stale'>;
  summary: ScopeSummary;
}
