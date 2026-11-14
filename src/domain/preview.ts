import type { ChangeOperation, DiffHunk, FileChange, MergeStrategy } from './models';
import type { IssueCode } from './errors';
import type { ScopeQuery, ScopeSummary } from './scope';
import type { TypePatch } from './type-config';

export interface PreviewDecision {
  path: string;
  beforeHash: string;
  selected: boolean;
  merge?: MergeStrategy;
  dateInterpretationConfirmed?: boolean;
  individual?: boolean;
}
export interface PreviewDecisionPatch {
  path: string;
  beforeHash: string;
  selected?: boolean;
  merge?: MergeStrategy;
  dateInterpretationConfirmed?: boolean;
  individual?: boolean;
}
export interface PreviewItem {
  path: string;
  state: 'ready' | 'conflict' | 'noop' | 'blocked';
  disposition: 'execute' | 'skip' | 'noop' | 'blocked';
  reason?: IssueCode;
  decision: PreviewDecision;
  conflict: boolean;
  allowedStrategies: MergeStrategy[];
  diffs: DiffHunk[];
  ambiguousDate?: string;
  conflictValues?: { source: string; target: string };
  stale?: boolean;
}
export interface PreviewSummary {
  total: number;
  execute: number;
  skip: number;
  noop: number;
  blocked: number;
  conflicts: number;
}
export interface PreviewView {
  id: string;
  revision: number;
  createdAt: number;
  operation: ChangeOperation;
  scopeSummary: ScopeSummary;
  snapshotRevision: number;
  items: readonly PreviewItem[];
  summary: PreviewSummary;
  typeSummary: TypeSummary;
  invalid?: IssueCode;
  retryOf?: string;
}
export interface TypeSummary {
  kind: 'none' | 'existing' | 'add' | 'unsupported';
  sourceKey?: string;
  targetKey?: string;
  type?: string;
}
export interface PreparedChange {
  path: string;
  beforeContent: string;
  beforeHash: string;
  afterContent: string;
  expectedAfterHash: string;
  decision: PreviewDecision;
}
export interface PreparedPlan {
  id: string;
  revision: number;
  createdAt: number;
  operation: ChangeOperation;
  scope: ScopeQuery;
  scopeSummary: ScopeSummary;
  settingsFingerprint: string;
  changes: readonly PreparedChange[];
  skipped: readonly { path: string; reason: IssueCode }[];
  typePatch?: TypePatch;
  typeBaseline?: string | null;
  retryOf?: string;
}
export interface AnalyzedOperation {
  state: PreviewItem['state'];
  reason?: IssueCode;
  conflict: boolean;
  allowedStrategies: MergeStrategy[];
  change?: FileChange;
  ambiguousDate?: string;
}
export interface ExecutionItem {
  path: string;
  status: 'applied' | 'failed' | 'stale' | 'not-run' | 'uncertain' | 'skipped';
  reason: IssueCode;
}
export interface ExecutionResult {
  transactionId: string;
  items: ExecutionItem[];
  cancelled: boolean;
  durationMs: number;
  typeStatus: string;
  requiresReconciliation: boolean;
}
export function summarizePreview(items: readonly PreviewItem[]): PreviewSummary {
  return items.reduce((total, item) => {
    total.total++;
    total[item.disposition]++;
    if (item.conflict && item.reason === 'conflict-unresolved') total.conflicts++;
    return total;
  }, { total: 0, execute: 0, skip: 0, noop: 0, blocked: 0, conflicts: 0 });
}
