import type { ChangeOperation } from './models';
import type { ScopeSummary } from './scope';
import type { IssueCode } from './errors';
import type { TypePatch } from './type-config';
import { isChangeOperation } from './operation';
import { isNotePath, isVaultPath } from './scope';

export type FileExecutionStatus = 'pending' | 'applying' | 'applied' | 'failed' | 'stale' | 'not-run' | 'uncertain';
export type FileRecoveryStatus = 'none' | 'restoring' | 'restored' | 'blocked' | 'uncertain';
export type ExecutionStatus = 'prepared' | 'running' | 'completed' | 'partial' | 'interrupted';
export type RecoveryStatus = 'none' | 'partial' | 'complete';
export interface JournalEntryV2 {
  path: string;
  beforeContent: string;
  beforeHash: string;
  expectedAfterHash: string;
}
export interface JournalTransactionV2 {
  schemaVersion: 2;
  transactionId: string;
  planId: string;
  createdAt: number;
  retryOf?: string;
  operation: ChangeOperation;
  scope: import('./scope').ScopeQuery;
  scopeSummary: ScopeSummary;
  entries: readonly JournalEntryV2[];
  skipped: readonly { path: string; reason: IssueCode }[];
  typePatch?: TypePatch;
  stateBudgetBytes: number;
}
export interface JournalFileState {
  path: string;
  execution: FileExecutionStatus;
  recovery: FileRecoveryStatus;
  reason?: IssueCode;
}
export interface JournalStateV2 {
  schemaVersion: 2;
  transactionId: string;
  revision: number;
  updatedAt: number;
  execution: ExecutionStatus;
  recovery: RecoveryStatus;
  entries: JournalFileState[];
  typeExecution: 'none' | FileExecutionStatus;
  typeRecovery: FileRecoveryStatus;
  typeReason?: IssueCode;
}
export interface LegacyEntry {
  path: string;
  beforeContent: string;
  beforeHash: string;
  afterHash?: string;
  state?: 'pending' | 'applied' | 'not-applied' | 'restored';
}
export interface LegacyTransaction {
  transactionId: string;
  createdAt: number;
  operation: ChangeOperation;
  status: 'in-progress' | 'committed' | 'partial' | 'rolled-back';
  entries: LegacyEntry[];
}
export type LoadedJournal =
  | { kind: 'v2'; transaction: JournalTransactionV2; state: JournalStateV2 | null; stateMissing: boolean; stateIssue?: IssueCode }
  | { kind: 'legacy'; transaction: LegacyTransaction; state: JournalStateV2 | null }
  | { kind: 'invalid'; transactionId: string; issue: IssueCode }
  | { kind: 'unsupported'; transactionId: string; issue: IssueCode };
export interface JournalListItem {
  transactionId: string;
  kind: LoadedJournal['kind'];
  createdAt: number;
  operation?: ChangeOperation;
  scopeSummary?: ScopeSummary;
  retryOf?: string;
  fileCount: number;
  execution?: ExecutionStatus | LegacyTransaction['status'];
  recovery?: RecoveryStatus;
  counts?: Partial<Record<FileExecutionStatus, number>>;
  bytes: number;
  reservedBytes: number;
  canRemove: boolean;
  needsReconciliation: boolean;
  issue?: IssueCode;
}
export function validJournalId(id: string): boolean { return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id); }
export const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;
export const isHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const finiteTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const executions: readonly string[] = ['pending', 'applying', 'applied', 'failed', 'stale', 'not-run', 'uncertain'];
const recoveries: readonly string[] = ['none', 'restoring', 'restored', 'blocked', 'uncertain'];
const optionalId = (value: unknown): boolean => value === undefined || typeof value === 'string' && validJournalId(value);

function validScope(value: unknown): boolean {
  if (!object(value) || !object(value.base) || !Array.isArray(value.conditions) || !Array.isArray(value.manuallyExcludedPaths)) return false;
  if (!(value.base.kind === 'all' || value.base.kind === 'folder' && typeof value.base.path === 'string' && isVaultPath(value.base.path) && typeof value.base.includeSubfolders === 'boolean')) return false;
  if (!value.manuallyExcludedPaths.every(path => typeof path === 'string' && isNotePath(path))) return false;
  return value.conditions.every(c => object(c) && typeof c.id === 'string' && (c.kind === 'tag'
    ? typeof c.tag === 'string' && ['contains', 'not-contains'].includes(String(c.operator)) && typeof c.includeDescendants === 'boolean'
    : c.kind === 'property' && typeof c.key === 'string' && (['exists', 'missing', 'empty'].includes(String(c.operator))
      || c.operator === 'equals' && (typeof c.value === 'string' || typeof c.value === 'boolean' || typeof c.value === 'number' && Number.isFinite(c.value)))));
}
function validSummary(value: unknown): boolean {
  return object(value) && validScope({ base: value.base, conditions: value.conditions, manuallyExcludedPaths: [] })
    && ['matched', 'manual', 'effective', 'unknown'].every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)
    && value.matched === (value.manual as number) + (value.effective as number);
}
export async function decodeJournal(raw: string | null, stateRaw: string | null, id: string, hash: (content: string) => Promise<string>): Promise<LoadedJournal> {
  const invalid = (): LoadedJournal => ({ kind: 'invalid', transactionId: id, issue: 'journal-invalid' });
  if (!validJournalId(id) || raw === null) return invalid();
  try {
    const value: unknown = JSON.parse(raw);
    if (!object(value)) return invalid();
    if (value.schemaVersion !== undefined && value.schemaVersion !== 2) return { kind: 'unsupported', transactionId: id, issue: 'journal-unsupported' };
    if (value.transactionId !== id || !finiteTime(value.createdAt) || !isChangeOperation(value.operation)
      || !Array.isArray(value.entries) || value.entries.length > 100000) return invalid();
    const paths = new Set<string>();
    for (const entry of value.entries) {
      if (!object(entry) || typeof entry.path !== 'string' || !isNotePath(entry.path) || paths.has(entry.path)
        || typeof entry.beforeContent !== 'string' || !isHash(entry.beforeHash) || await hash(entry.beforeContent) !== entry.beforeHash) return invalid();
      paths.add(entry.path);
      if (value.schemaVersion === 2 ? !isHash(entry.expectedAfterHash) : entry.afterHash !== undefined && !isHash(entry.afterHash)) return invalid();
      if (value.schemaVersion === undefined && entry.state !== undefined && !['pending', 'applied', 'not-applied', 'restored'].includes(String(entry.state))) return invalid();
    }
    if (value.schemaVersion === 2) {
      if (typeof value.planId !== 'string' || !validJournalId(value.planId) || !optionalId(value.retryOf)
        || !validScope(value.scope) || !validSummary(value.scopeSummary) || !Array.isArray(value.skipped)
        || !Number.isSafeInteger(value.stateBudgetBytes) || (value.stateBudgetBytes as number) <= 0) return invalid();
      for (const skip of value.skipped) {
        if (!object(skip) || typeof skip.path !== 'string' || !isNotePath(skip.path) || typeof skip.reason !== 'string' || paths.has(skip.path)) return invalid();
        paths.add(skip.path);
      }
      if (value.typePatch !== undefined) {
        const p = value.typePatch;
        if (!object(p) || !['sourceKey', 'targetKey', 'targetAfter', 'configBeforeContent', 'configAfterContent'].every(k => typeof p[k] === 'string')
          || !isHash(p.configBeforeHash) || !isHash(p.configAfterHash)
          || await hash(p.configBeforeContent as string) !== p.configBeforeHash || await hash(p.configAfterContent as string) !== p.configAfterHash) return invalid();
      }
      const transaction = value as unknown as JournalTransactionV2;
      const state = decodeState(stateRaw, id, transaction.entries.map(entry => entry.path));
      return { kind: 'v2', transaction, state, stateMissing: stateRaw === null, ...(!state ? { stateIssue: 'evidence-missing' as const } : {}) };
    }
    if (!['in-progress', 'committed', 'partial', 'rolled-back'].includes(String(value.status))) return invalid();
    const transaction = value as unknown as LegacyTransaction;
    return { kind: 'legacy', transaction, state: decodeState(stateRaw, id, transaction.entries.map(entry => entry.path)) };
  } catch { return invalid(); }
}
export function decodeState(raw: string | null, id: string, paths: readonly string[]): JournalStateV2 | null {
  try {
    const s: unknown = raw === null ? null : JSON.parse(raw);
    if (!object(s) || s.schemaVersion !== 2 || s.transactionId !== id || !Number.isSafeInteger(s.revision) || (s.revision as number) < 0
      || !finiteTime(s.updatedAt) || !['prepared', 'running', 'completed', 'partial', 'interrupted'].includes(String(s.execution))
      || !['none', 'partial', 'complete'].includes(String(s.recovery)) || !Array.isArray(s.entries) || s.entries.length !== paths.length
      || !['none', ...executions].includes(String(s.typeExecution)) || !recoveries.includes(String(s.typeRecovery))) return null;
    const seen = new Set<string>(), expectedPaths = new Set(paths);
    for (const e of s.entries) {
      if (!object(e) || typeof e.path !== 'string' || !expectedPaths.has(e.path) || seen.has(e.path)
        || !executions.includes(String(e.execution)) || !recoveries.includes(String(e.recovery))
        || e.reason !== undefined && typeof e.reason !== 'string') return null;
      seen.add(e.path);
    }
    return s as unknown as JournalStateV2;
  } catch { return null; }
}
export function initialState(transaction: JournalTransactionV2): JournalStateV2 {
  return { schemaVersion: 2, transactionId: transaction.transactionId, revision: 0, updatedAt: Date.now(), execution: 'prepared', recovery: 'none',
    entries: transaction.entries.map(entry => ({ path: entry.path, execution: 'pending', recovery: 'none' })), typeExecution: transaction.typePatch ? 'pending' : 'none', typeRecovery: 'none' };
}
export function hasStarted(status: FileExecutionStatus | undefined): boolean { return status === 'applied' || status === 'applying' || status === 'uncertain'; }
export function needsReconciliation(loaded: LoadedJournal): boolean {
  if (loaded.kind === 'invalid' || loaded.kind === 'unsupported') return true;
  const s = loaded.state;
  if (!s) return loaded.kind === 'v2' || loaded.transaction.status === 'in-progress';
  if (s.recovery === 'complete' && s.entries.every(entry => entry.recovery === 'restored' || ['failed', 'stale', 'not-run'].includes(entry.execution))
    && (s.typeRecovery === 'restored' || ['none', 'failed', 'stale', 'not-run'].includes(s.typeExecution))) return false;
  return ['prepared', 'running', 'interrupted'].includes(s.execution) || s.typeExecution === 'applying' || s.typeExecution === 'uncertain'
    || s.typeRecovery === 'restoring' || s.typeRecovery === 'uncertain' || s.entries.some(e => e.execution === 'applying' || e.execution === 'uncertain' || e.recovery === 'restoring' || e.recovery === 'uncertain');
}
export function canRemoveJournal(loaded: LoadedJournal): boolean {
  if (loaded.kind === 'invalid' || loaded.kind === 'unsupported' || needsReconciliation(loaded)) return false;
  const state = loaded.state;
  if (!state) return loaded.kind === 'legacy' && loaded.transaction.status === 'committed';
  return state.recovery === 'complete' || state.execution === 'completed' && state.recovery === 'none';
}
