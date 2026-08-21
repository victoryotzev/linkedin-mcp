// Machine-actionable error taxonomy. Every tool failure surfaces one of these
// codes inside the result (isError: true), never a bare protocol error.
export type ErrorCode =
  | 'CAPABILITY_UNAVAILABLE'
  | 'EVIDENCE_NOT_VERIFIED'
  | 'CLAIM_REJECTED_TOMBSTONE'
  | 'REVISION_CONFLICT'
  | 'APPROVAL_INVALIDATED'
  | 'ACCOUNT_MISMATCH'
  | 'INTEGRITY_ERROR'
  | 'PATH_REJECTED'
  | 'SECRET_VIA_MCP_FORBIDDEN'
  | 'TERMINAL_STATE'
  | 'DB_CONTENTION'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INTERNAL';

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly blockers: string[];
  readonly retryable: boolean;
  readonly dashboardUrl: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { blockers?: string[]; retryable?: boolean; dashboardUrl?: string } = {},
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.blockers = opts.blockers ?? [];
    this.retryable = opts.retryable ?? false;
    this.dashboardUrl = opts.dashboardUrl;
  }

  toResultPayload(): {
    code: ErrorCode;
    message: string;
    blockers: string[];
    retryable: boolean;
    dashboard_url?: string;
  } {
    const payload: {
      code: ErrorCode;
      message: string;
      blockers: string[];
      retryable: boolean;
      dashboard_url?: string;
    } = {
      code: this.code,
      message: this.message,
      blockers: this.blockers,
      retryable: this.retryable,
    };
    if (this.dashboardUrl !== undefined) payload.dashboard_url = this.dashboardUrl;
    return payload;
  }
}
