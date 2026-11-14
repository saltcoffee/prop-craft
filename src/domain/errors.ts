export type IssueCode =
  | 'scope-invalid' | 'input-invalid' | 'frontmatter-invalid' | 'metadata-stale'
  | 'file-stale' | 'file-missing' | 'read-failed' | 'write-failed'
  | 'journal-capacity' | 'journal-unavailable' | 'journal-invalid' | 'journal-unsupported'
  | 'type-config-unsupported' | 'type-config-stale' | 'type-incompatible' | 'type-in-use'
  | 'invalid-decision' | 'operation-busy' | 'recovery-required' | 'plan-invalid'
  | 'source-missing' | 'already-equal' | 'already-normalized' | 'date-unrecognized'
  | 'date-non-text' | 'date-ambiguous' | 'conflict-unresolved' | 'policy-skip'
  | 'user-unselected' | 'no-change' | 'cancelled' | 'external-edit' | 'evidence-missing'
  | 'globally-excluded' | 'already-original' | 'restored' | 'applied' | 'not-run' | 'uncertain' | 'reserved-key';

export class OperationError extends Error {
  constructor(readonly code: IssueCode, readonly path?: string) {
    super(code);
    this.name = 'OperationError';
  }
}

export function issueCode(error: unknown, fallback: IssueCode): IssueCode {
  return error instanceof OperationError ? error.code : fallback;
}
