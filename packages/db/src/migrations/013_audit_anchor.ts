// The hash chain only proved that surviving rows link to each other. Nothing
// anchored either END of it, so deleting the newest N events — or the whole
// table, after which fresh events re-chain cleanly from genesis — left
// verifyAuditChain reporting valid:true and the dashboard printing "chain
// verified". Deleting a row from the MIDDLE was caught, which is what made the
// gap easy to miss.
//
// This seeds the anchor for databases that already hold events, so a missing
// anchor is an anomaly from here on rather than an unknown. The anchor lives in
// the same file it protects, so it does not defeat an adversary with write
// access — nothing stored beside the data can. It closes accidental truncation
// and naive tampering, which is the realistic threat for a local single-user
// ledger.
export const MIGRATION_013 = `
INSERT INTO settings (key, value_json, updated_at)
SELECT
  'audit.head',
  json_object(
    'seq',  COALESCE((SELECT MAX(seq) FROM audit_events), 0),
    'hash', COALESCE((SELECT content_hash FROM audit_events ORDER BY seq DESC LIMIT 1),
                     '0000000000000000000000000000000000000000000000000000000000000000')
  ),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'audit.head');
`;
