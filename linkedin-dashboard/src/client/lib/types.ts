// Response shapes, mirrored from the domain types the routes return.
//
// Declared rather than imported: the client is bundled for the browser, and
// importing from @linkedin-mcp/domain would drag node:sqlite and the whole
// service layer across the boundary. The DOM tests drive the real
// buildDashboardApp over a seeded database, so drift between these and the
// actual responses shows up as a test failure rather than as a blank panel.

export interface Paged<T> {
  items: T[];
  total: number;
  has_more: boolean;
}

export type ClaimState = 'candidate' | 'verified' | 'ambiguous' | 'rejected' | 'expired';

export interface Claim {
  id: string;
  statement: string;
  state: ClaimState;
  method: string;
  sensitivity: string;
  limitations: string | null;
  review_by: string | null;
  reviewed_at: string | null;
  rejected_reason: string | null;
  created_at: string;
}

export interface ClaimEvidence {
  artifact_id: string;
  source_relpath: string;
  source_label: string;
  source_trust: string;
  role: string;
  location: Record<string, unknown>;
  excerpt: string | null;
  /** Stored bytes no longer match the hash recorded at import. Blocks verification. */
  integrity_error: string | null;
}

export interface Source {
  id: string;
  kind: string;
  root_path: string;
  label: string;
  trust: string;
  status: string;
  registered_at: string;
  last_import_at: string | null;
}

export interface Conflict {
  id: string;
  type: string;
  state: string;
  resolution_note: string | null;
  created_at: string;
  members: Array<{ claim_id: string; statement: string; state: string }>;
}

export interface ArtifactSummary {
  id: string;
  source_id: string;
  source_relpath: string;
  sha256: string;
  size_bytes: number;
  mime: string;
  imported_at: string;
  superseded: boolean;
  contains_secrets: boolean;
}

export interface CanonicalRevision {
  id: string;
  section_key: string;
  content_text: string;
  claim_ids: string[];
  rationale: string | null;
  created_at: string;
}

export interface ScoreFinding {
  dimension: string;
  score: number;
  explanation: string;
  details: string[];
}

export interface FieldPatch {
  id: string;
  change_set_id: string;
  field_key: string;
  old_text: string;
  new_text: string;
  char_limit: number | null;
  char_count: number;
  char_limit_ok: boolean;
  claim_ids: string[];
  rationale: string | null;
  risk_note: string | null;
  kind: string;
  state: string;
  applied_at: string | null;
  applied_verified_snapshot_id: string | null;
}

export interface ChangeSetSummary {
  id: string;
  title: string;
  state: string;
  created_at: string;
  patch_count: number;
  proposed_count: number;
  approved_count: number;
}

export interface ExportBundleEntry {
  patch_id: string;
  field_key: string;
  kind: string;
  exact_text: string;
  char_count: number;
  char_limit: number | null;
  /** Where in LinkedIn's own UI to paste it. There is no profile-edit API. */
  ui_hint: string;
}

export interface CheckResult {
  check: string;
  passed: boolean;
  detail: string;
  offenders: string[];
}

export interface ValidationReport {
  id: string;
  draft_id: string;
  revision_hash: string;
  passed: boolean;
  checks: CheckResult[];
  created_at: string;
  corpus_fingerprint: string | null;
}

export interface Draft {
  id: string;
  slug: string;
  state: string;
  current_revision: number;
  current_revision_hash: string | null;
  updated_at: string;
  validation?: ValidationReport | null;
}

export interface DraftRevision {
  draft_id: string;
  revision: number;
  body_text: string;
  visibility: string;
  revision_hash: string;
  created_at: string;
  media: Array<{ artifact_id: string; alt: string }>;
}

export interface SentenceCoverage {
  index: number;
  text: string;
  status: 'supported' | 'partial' | 'unsupported';
  claim_ids: string[];
  best_score: number;
}

export interface Opportunity {
  claim_id: string;
  statement: string;
  limitations: string | null;
  novelty: number;
  closest_prior: string | null;
}

export interface ApprovalPreview {
  draft_id: string;
  revision_hash: string;
  body_text: string;
  visibility: string;
  media: Array<{ artifact_id: string; alt: string }>;
  char_count: number;
  account_id: string;
  intended_time: string | null;
  /**
   * False when the draft moved on after this approval was requested. The
   * preview always shows the BOUND revision — the bytes that would actually be
   * published — so this is the reviewer's warning that the draft they have been
   * editing is not the one under approval.
   */
  revision_is_current: boolean;
}

export interface Approval {
  id: string;
  draft_id: string;
  revision_hash: string;
  account_id: string;
  visibility: string;
  state: string;
  requested_by: 'mcp_host' | 'dashboard';
  intended_time: string | null;
  expires_at: string;
  invalidated_by: string | null;
  created_at: string;
  preview: ApprovalPreview | null;
}

export interface Publication {
  id: string;
  draft_id: string;
  approval_id: string;
  adapter: string;
  linkedin_post_urn: string | null;
  outcome: string;
  attempted_at: string;
  resolved_at: string | null;
}

export interface ChainStatus {
  valid: boolean;
  length: number;
  head_hash: string;
  broken_at_seq: number | null;
  reason: string | null;
  head_anchored: boolean;
}

export interface Capability {
  feature: string;
  status: string;
  blockers: string[];
  api_version: string | null;
  verified_at: string | null;
  remediation: string;
}

export interface FeatureControl {
  key: string;
  title: string;
  description: string;
  enabled: boolean;
  default_enabled: boolean;
}

export interface LaneAccount {
  id: string;
  lane: 'read' | 'write';
  label: string;
  client_id: string | null;
  person_urn: string | null;
  status: string;
  token_expires_at: string | null;
  /** Whether a token is stored. Never the token. */
  has_token: boolean;
}

export interface AuditEvent {
  seq: number;
  event_type: string;
  actor: string;
  subject_type: string;
  subject_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface RetentionSummary {
  classes: Array<{ retention_class: string; observations: number }>;
  policy: Record<string, string>;
}

export interface Observation {
  id: string;
  subject_ref: string;
  metric: string;
  value: number;
  observed_at: string;
  source: string;
  retention_class: string;
}

export interface VoiceProfile {
  posts: number;
  first_post: string | null;
  last_post: string | null;
  median_chars: number;
  language_mix: Record<string, number>;
  hashtags_per_post: number;
  top_hashtags: Array<{ tag: string; count: number }>;
  posts_with_link: number;
}

export interface PatchStateCounts {
  proposed: number;
  approved: number;
  applied: number;
  superseded: number;
  rejected: number;
}

export interface WorkbenchSummary {
  counts: {
    claims: Record<ClaimState, number>;
    claims_stale: number;
    conflicts_open: number;
    sources_pending: number;
    artifacts: number;
    patches: PatchStateCounts;
    patches_applied_unverified: number;
    drafts_failing_validation: number;
    drafts_unvalidated: number;
    drafts_validated: number;
  };
  approvals: { pending: Approval[]; armed: Approval[] };
  publications_unresolved: Publication[];
  capabilities: Capability[];
  lanes: LaneAccount[];
  score: ScoreFinding[];
  recent_events: AuditEvent[];
  generated_at: string;
}

export type ReadinessCheckStatus = 'ok' | 'action_needed' | 'unavailable';

export interface ReadinessCheck {
  id: string;
  title: string;
  status: ReadinessCheckStatus;
  detail: string;
  remediation: string | null;
}

export interface ReadinessReport {
  is_first_run: boolean;
  next_step: string;
  checks: ReadinessCheck[];
  counts: {
    sources_enabled: number;
    sources_pending: number;
    artifacts: number;
    claims_verified: number;
    claims_awaiting_review: number;
  };
}

export interface UploadResult {
  source_id: string;
  label: string;
  trust: string;
  imported: number;
  results: Array<{ filename: string; imported: boolean; reason: string | null }>;
}

export interface DescribeResult {
  source_id: string;
  artifact_id: string;
  trust: string;
  char_count: number;
}
