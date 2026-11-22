import type { ChangeOperation, DiffHunk, FileChange, MergeStrategy } from './models';
import type { ActualValueType } from './property-value';
import type { IssueCode } from './errors';
import type { ScopeQuery, ScopeSummary } from './scope';
import type { TypePatch } from './type-config';
import type { TagBranchMapping, TagCollisionReport } from './tag-migration';
import type { MatchedTagSource, TagPropertyResolution, TagSourceDisposition } from './tag-property';

export type { TagPropertyResolution } from './tag-property';

export interface TagMigrationCandidateView {
  id: string;
  resolution: TagPropertyResolution;
  ruleIds: readonly string[];
  value: unknown;
  afterType: ActualValueType;
  propertyChanged: boolean;
  representedRuleIds: readonly string[];
  removableRuleIds: readonly string[];
  retainedRuleIds: readonly string[];
  dispositions: readonly TagSourceDisposition[];
  requiredConfirmations: readonly ValueConfirmation[];
  diffs: readonly DiffHunk[];
  selectable: boolean;
  blockedReason?: IssueCode;
  blockedDetail?: string;
}

export interface TagMigrationAnalysis {
  matchedRuleIds: readonly string[];
  matchedSources: readonly MatchedTagSource[];
  hasExisting: boolean;
  existingValue?: unknown;
  existingType?: ActualValueType;
  requiresResolution: boolean;
  allowedResolutions: readonly TagPropertyResolution[];
  candidates: readonly TagMigrationCandidateView[];
  selectedCandidateId?: string;
  issues: readonly { code: IssueCode; ruleIds?: readonly string[]; detail?: string }[];
}

export interface TagBranchSummary {
  mappings: readonly TagBranchMapping[];
  collisions: TagCollisionReport;
  overlap: boolean;
}

export type ValueConfirmation = 'value-loss' | 'declared-type-mismatch' | 'date-interpretation';
export interface ValueIssue { code: IssueCode; detail?: string }
export interface ValueAnalysis {
  outcome: 'ready' | 'needs-confirmation' | 'unconvertible' | 'noop';
  /** Missing values have no actual type. */
  beforeType?: ActualValueType;
  afterType?: ActualValueType;
  candidate?: unknown;
  ruleIds: readonly string[];
  issues: readonly ValueIssue[];
  requiredConfirmations: readonly ValueConfirmation[];
}
export interface ValueSummary {
  ready: number;
  needsConfirmation: number;
  unconvertible: number;
  noop: number;
}

export interface PreviewDecision {
  path: string;
  beforeHash: string;
  selected: boolean;
  merge?: MergeStrategy;
  dateInterpretationConfirmed?: boolean;
  valueLossConfirmed?: boolean;
  declaredTypeMismatchConfirmed?: boolean;
  tagPropertyResolution?: TagPropertyResolution;
  individual?: boolean;
}
export interface PreviewDecisionPatch {
  path: string;
  beforeHash: string;
  selected?: boolean;
  merge?: MergeStrategy;
  dateInterpretationConfirmed?: boolean;
  valueLossConfirmed?: boolean;
  declaredTypeMismatchConfirmed?: boolean;
  tagPropertyResolution?: TagPropertyResolution | null;
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
  valueAnalysis?: ValueAnalysis;
  tagAnalysis?: TagMigrationAnalysis;
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
  valueSummary?: ValueSummary;
  tagBranchSummary?: TagBranchSummary;
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
  valueAnalysis?: ValueAnalysis;
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
const UNRESOLVED_CONFLICT_REASONS: ReadonlySet<IssueCode> = new Set([
  'conflict-unresolved',
  'date-ambiguous',
  'date-value-loss',
  'number-representation',
  'declared-type-mismatch',
  'tag-scalar-conflict',
  'tag-target-conflict',
]);

export function summarizePreview(items: readonly PreviewItem[]): PreviewSummary {
  return items.reduce((total, item) => {
    total.total++;
    total[item.disposition]++;
    if (item.conflict && item.reason && UNRESOLVED_CONFLICT_REASONS.has(item.reason)) total.conflicts++;
    return total;
  }, { total: 0, execute: 0, skip: 0, noop: 0, blocked: 0, conflicts: 0 });
}
