import type { IssueCode } from './errors';
export interface RecoveryItem {
  path: string;
  kind: 'restore' | 'original' | 'restored' | 'blocked' | 'not-applied';
  reason: IssueCode;
}
export interface RecoveryPreview {
  id: string;
  revision: number;
  transactionId: string;
  items: RecoveryItem[];
  type: { kind: 'none' | 'restore' | 'original' | 'blocked'; reason?: IssueCode; targetKey?: string; value?: string };
  legacy: boolean;
  evidenceIssue?: IssueCode;
  canConfirmOriginal?: boolean;
}
export interface RecoveryResult {
  transactionId: string;
  items: RecoveryItem[];
  complete: boolean;
  typeReason?: IssueCode;
  requiresReconciliation: boolean;
}
