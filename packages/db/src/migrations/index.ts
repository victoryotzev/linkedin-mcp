import { MIGRATION_001 } from './001_core.ts';
import { MIGRATION_002 } from './002_capabilities.ts';
import { MIGRATION_003 } from './003_sources.ts';
import { MIGRATION_004 } from './004_claims.ts';
import { MIGRATION_005 } from './005_profile.ts';
import { MIGRATION_006 } from './006_changesets.ts';
import { MIGRATION_007 } from './007_coverage_corpus.ts';
import { MIGRATION_008 } from './008_content.ts';
import { MIGRATION_009 } from './009_approvals.ts';
import { MIGRATION_010 } from './010_analytics.ts';
import { MIGRATION_011 } from './011_secrets.ts';
import { MIGRATION_012 } from './012_published_posts_dma.ts';
import { MIGRATION_013 } from './013_audit_anchor.ts';
import { MIGRATION_014 } from './014_validation_corpus.ts';
import { MIGRATION_015 } from './015_dma_changelog.ts';
import { MIGRATION_016 } from './016_human_cli_actor.ts';
import { MIGRATION_017 } from './017_dma_observations.ts';
import { MIGRATION_018 } from './018_observation_comparability.ts';
import { MIGRATION_019 } from './019_self_attested_trust.ts';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Forward-only, append-only. Never edit an entry after it has shipped — the
// runner fails closed on checksum drift. Recovery is restore-from-backup, not
// a down migration.
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'core', sql: MIGRATION_001 },
  { version: 2, name: 'capabilities', sql: MIGRATION_002 },
  { version: 3, name: 'sources', sql: MIGRATION_003 },
  { version: 4, name: 'claims', sql: MIGRATION_004 },
  { version: 5, name: 'profile', sql: MIGRATION_005 },
  { version: 6, name: 'changesets', sql: MIGRATION_006 },
  { version: 7, name: 'coverage_corpus', sql: MIGRATION_007 },
  { version: 8, name: 'content', sql: MIGRATION_008 },
  { version: 9, name: 'approvals', sql: MIGRATION_009 },
  { version: 10, name: 'analytics', sql: MIGRATION_010 },
  { version: 11, name: 'secrets', sql: MIGRATION_011 },
  { version: 12, name: 'published_posts_dma', sql: MIGRATION_012 },
  { version: 13, name: 'audit_anchor', sql: MIGRATION_013 },
  { version: 14, name: 'validation_corpus', sql: MIGRATION_014 },
  { version: 15, name: 'dma_changelog', sql: MIGRATION_015 },
  { version: 16, name: 'human_cli_actor', sql: MIGRATION_016 },
  { version: 17, name: 'dma_observations', sql: MIGRATION_017 },
  { version: 18, name: 'observation_comparability', sql: MIGRATION_018 },
  { version: 19, name: 'self_attested_trust', sql: MIGRATION_019 },
];
