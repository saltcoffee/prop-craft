import fixtures from '../fixtures/0.1.4/notes.json';
import type { ConvertTagsToPropertyOperation, TagPropertyRule } from '../../src/domain/models';
import type { ScopeQuery } from '../../src/domain/scope';
import type { MemoryVault } from './vault';

export interface FixtureNote {
  path: string;
  content: string;
}

export const BRANCH_NOTES: readonly FixtureNote[] = fixtures.branch;
export const CONVERT_NOTES: readonly FixtureNote[] = fixtures.convert;

export function loadBranchFixtures(vault: MemoryVault): void {
  for (const note of BRANCH_NOTES) vault.setText(note.path, note.content);
}

export function loadConvertFixtures(vault: MemoryVault): void {
  for (const note of CONVERT_NOTES) vault.setText(note.path, note.content);
}

export const BRANCH_SCOPE: ScopeQuery = {
  base: { kind: 'folder', path: 'Cases/Branch', includeSubfolders: true },
  conditions: [],
  manuallyExcludedPaths: [],
};

export const CONVERT_SCOPE: ScopeQuery = {
  base: { kind: 'folder', path: 'Cases/Convert', includeSubfolders: true },
  conditions: [],
  manuallyExcludedPaths: [],
};

export const STATUS_RULES: readonly TagPropertyRule[] = [
  { id: 'r-done', tag: '#状态/已读', value: { type: 'text', value: 'done' } },
  { id: 'r-reading', tag: '#状态/在读', value: { type: 'text', value: 'reading' } },
  { id: 'r-finished', tag: '#状态/完成', value: { type: 'text', value: 'done' } },
];

export const SUBJECT_RULES: readonly TagPropertyRule[] = [
  { id: 'r-history', tag: '#学科/历史', value: { type: 'text', value: 'history' } },
  { id: 'r-lit', tag: '#学科/文学', value: { type: 'text', value: 'literature' } },
];

export function statusOperation(removeSourceTags = false): ConvertTagsToPropertyOperation {
  return {
    kind: 'convertTagsToProperty',
    key: 'status',
    mode: 'scalar',
    rules: STATUS_RULES,
    removeSourceTags,
  };
}

export function subjectOperation(removeSourceTags = false): ConvertTagsToPropertyOperation {
  return {
    kind: 'convertTagsToProperty',
    key: 'subjects',
    mode: 'list',
    rules: SUBJECT_RULES,
    removeSourceTags,
  };
}
