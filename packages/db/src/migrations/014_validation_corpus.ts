// A validation report recorded only the revision_hash of the TEXT it checked.
// Its most important check — unsupported_claims — is a statement about the
// verified-claim corpus, and that corpus changes independently of the draft. So
// a report that passed while a claim was verified stayed authoritative after
// the member rejected that claim as false, and requestApproval, which compares
// text hashes only, still opened the human approval gate.
//
// coverage_reports already carries corpus_fingerprint for exactly this reason
// (migration 007). This adds the same anchor at the layer that actually gates
// publishing. Existing rows get NULL, which reads as "fingerprint unknown" and
// is treated as stale — re-validating is cheap, publishing on withdrawn
// evidence is not.
export const MIGRATION_014 = `
ALTER TABLE validation_reports ADD COLUMN corpus_fingerprint TEXT;
`;
