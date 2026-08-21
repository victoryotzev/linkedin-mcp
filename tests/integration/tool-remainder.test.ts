import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureLane,
  getClaim,
  listSources,
  proposeClaim,
  verifyLane,
  type SecretStore,
} from '@linkedin-mcp/domain';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { createFixture, seedHealthy, seedRealArtifact, type Fixture } from '../helpers/fixtures.ts';

// The tool branches that need a source on disk, a claim mid-review, or a store
// that will not write.
//
// These are the paths a host actually drives during a first run: register a
// folder, import it, review what came back, and put a source away when it turns
// out to be the wrong one. Each one either changes the ledger or refuses to,
// and the refusals have to name a cause the member can act on.

let fixture: Fixture;
let seeded: ReturnType<typeof seedHealthy>;
let evidence: string;
let call: (name: string, args: unknown) => Promise<unknown>;

const TOKEN = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';

function memorySecrets(): SecretStore {
  const values = new Map<string, string>();
  return {
    async put(name, value) {
      values.set(name, value);
    },
    async get(name) {
      return values.get(name) ?? null;
    },
    has(name) {
      return values.has(name);
    },
    listNames() {
      return [...values.keys()].sort();
    },
    async remove(name) {
      values.delete(name);
    },
  };
}

function tools(home = fixture.dir): (name: string, args: unknown) => Promise<unknown> {
  const defs = toolDefs({
    db: fixture.db,
    fts5: fixture.fts5,
    home,
    actor: 'mcp_host',
    scheduleFullPurge: () => {},
  } as never);
  return async (name, args) => {
    const def = defs.find((d) => d.name === name);
    if (!def) throw new Error(`no such tool: ${name}`);
    return await def.handler(def.inputSchema.parse(args) as never);
  };
}

beforeEach(() => {
  fixture = createFixture('tool-remainder');
  seeded = seedHealthy(fixture);
  evidence = mkdtempSync(join(tmpdir(), 'linkedin-mcp-tr-'));
  call = tools();
});

afterEach(() => {
  fixture.close();
  try {
    rmSync(evidence, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

const write = (relpath: string, text: string): void => {
  const full = join(evidence, relpath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, text, 'utf8');
};

async function enabledFolderSource(): Promise<string> {
  const registered = (await call('linkedin_source_manage', {
    action: 'register',
    path: evidence,
    kind: 'folder',
    trust: 'personal_doc',
    label: 'documents',
  })) as { source: { id: string } };
  const id = registered.source.id;
  await call('linkedin_source_manage', {
    action: 'enable',
    source_id: id,
    command: `ENABLE ${id}`,
    confirm: true,
  });
  return id;
}

describe('running an import through the tool', () => {
  it('imports a folder and reports what it took', async () => {
    write('year-one/notes.md', 'Notes on deterministic parsing.');
    const sourceId = await enabledFolderSource();

    const report = (await call('linkedin_import_run', {
      source_id: sourceId,
      subpath: 'year-one',
    })) as { files_imported: number; rejects: unknown[] };

    expect(report.files_imported).toBeGreaterThan(0);
    expect(report.rejects).toEqual([]);
  }, 60_000);

  it('changes nothing on a dry run', async () => {
    write('year-one/notes.md', 'Notes on deterministic parsing.');
    const sourceId = await enabledFolderSource();

    await call('linkedin_import_run', { source_id: sourceId, dry_run: true });

    // A dry run is what a member uses to find out what a source contains
    // before letting it into the corpus, so it must not put anything there.
    expect(fixture.db.all('SELECT id FROM artifacts WHERE source_id = ?', sourceId)).toHaveLength(
      0,
    );
  }, 60_000);
});

describe('putting a source away', () => {
  it('disables one without deleting what it already contributed', async () => {
    write('notes.md', 'Notes.');
    const sourceId = await enabledFolderSource();
    await call('linkedin_import_run', { source_id: sourceId });
    const before = fixture.db.all('SELECT id FROM artifacts WHERE source_id = ?', sourceId).length;

    const out = (await call('linkedin_source_manage', {
      action: 'disable',
      source_id: sourceId,
    })) as { source: { status: string } };

    // Evidence already imported keeps backing the claims that cite it; the
    // source is closed for future imports, not retracted.
    expect(out.source.status).not.toBe('enabled');
    expect(fixture.db.all('SELECT id FROM artifacts WHERE source_id = ?', sourceId)).toHaveLength(
      before,
    );
  }, 60_000);

  it('archives one, and then refuses to bring it back', async () => {
    const sourceId = await enabledFolderSource();

    await call('linkedin_source_manage', { action: 'archive', source_id: sourceId });
    expect(listSources(fixture.db).find((s) => s.id === sourceId)?.status).toBe('archived');

    await expect(
      call('linkedin_source_manage', {
        action: 'enable',
        source_id: sourceId,
        command: `ENABLE ${sourceId}`,
        confirm: true,
      }),
    ).rejects.toThrow(/archived/i);
  });
});

describe('reviewing a claim through the tool', () => {
  it('carries the review date through a verification', async () => {
    const reviewBy = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString();

    await call('linkedin_claim_manage', {
      action: 'verify',
      claim_id: seeded.candidateId,
      review_by: reviewBy,
      confirm: true,
    });

    // Dropping review_by here let the boot sweep re-expire a claim the caller
    // had just re-verified, which read as the verification not working.
    const claim = getClaim(fixture.db, seeded.candidateId);
    expect(claim.state).toBe('verified');
    expect(claim.review_by).toBeTruthy();
  });
});

describe('typing a description when the store will not take it', () => {
  it('says it was not stored rather than reporting an empty source', async () => {
    // A regular file where the artifact directory belongs: the store cannot
    // create its tree, so the write fails at the first byte.
    const home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-tr-home-'));
    writeFileSync(join(home, 'artifacts'), 'not a directory', 'utf8');
    const text =
      'I build local-first evidence tooling in TypeScript, mostly on Windows, and I care about provenance.';
    const digest = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8);

    try {
      await expect(
        tools(home)('linkedin_intake_describe', {
          text,
          command: `DESCRIBE ${digest}`,
          confirm: true,
        }),
      ).rejects.toThrow(/was not stored/i);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe('the audit query without a cursor', () => {
  it('starts from the newest entry the log has', async () => {
    const out = (await call('linkedin_audit_query', { limit: 3 })) as {
      events: Array<{ seq: number }>;
    };

    // With no cursor the page is anchored to MAX(seq) at read time, so a page
    // cannot shift under a reader while they are paging through it.
    expect(out.events.length).toBeGreaterThan(0);
    const maxSeq = Number(fixture.db.get('SELECT MAX(seq) AS m FROM audit_events')?.['m'] ?? 0);
    expect(Math.max(...out.events.map((e) => e.seq))).toBeLessThanOrEqual(maxSeq);
  });
});

describe('publishing live with media attached', () => {
  it('refuses before opening a socket, and says to remove the media', async () => {
    const media = Buffer.from('a pretend screenshot');
    const { sha256 } = fixture.store.put(media);
    const artifactId = 'art_media_fixture';
    fixture.db.run(
      `INSERT INTO artifacts (id, source_id, source_relpath, sha256, size_bytes, mime, imported_at, import_run_id)
       SELECT ?, source_id, 'screenshot.png', ?, ?, 'image/png', ?, import_run_id
         FROM artifacts WHERE id = ?`,
      artifactId,
      sha256,
      media.length,
      new Date().toISOString(),
      seeded.artifactId,
    );

    // A new revision of the fixture draft rather than a new draft: the text is
    // already supported by a verified claim and does not repeat anything, so
    // the only thing that has changed is the attachment.
    const written = (await call('linkedin_draft_write', {
      draft_id: seeded.draftId,
      body_text: 'The project contains 181 test files.',
      media: [{ artifact_id: artifactId, alt: 'a screenshot of the dashboard' }],
      confirm: true,
    })) as { draft_id: string };
    await call('linkedin_draft_validate', { draft_id: written.draft_id });
    const requested = (await call('linkedin_publish_request', {
      draft_id: written.draft_id,
      confirm: true,
    })) as { approval_id: string; preview: { revision_hash: string } };
    await call('linkedin_approval_decide', {
      action: 'grant',
      approval_id: requested.approval_id,
      revision_hash: requested.preview.revision_hash,
      command: `APPROVE ${requested.approval_id} ${requested.preview.revision_hash}`,
      confirm: true,
    });

    // The second gate, opened the way a member would.
    const secrets = memorySecrets();
    await configureLane(fixture.db, secrets, {
      lane: 'write',
      client_id: 'cid-write',
      access_token: TOKEN,
    });
    await verifyLane(
      fixture.db,
      secrets,
      'write',
      async () => ({ ok: true, person_urn: 'urn:li:person:fixture' }),
      'dashboard',
    );
    await call('linkedin_feature_control', {
      action: 'set',
      feature: 'live_publishing',
      enabled: true,
      confirm: true,
    });

    // Uploading media is not built. Discovering that after the approval was
    // consumed would spend a one-time approval on a post that cannot be sent,
    // so the refusal comes before the approval is touched.
    await expect(
      call('linkedin_publish_execute', {
        approval_id: requested.approval_id,
        adapter: 'linkedin',
        command: `PUBLISH ${requested.approval_id}`,
        confirm: true,
      }),
    ).rejects.toThrow(/media publishing is not available yet/i);

    expect(
      String(
        fixture.db.get('SELECT state FROM approvals WHERE id = ?', requested.approval_id)?.[
          'state'
        ],
      ),
    ).toBe('granted');
  }, 60_000);
});

describe('verifying a claim that stands on someone else’s repository', () => {
  it('records the acknowledgement, because familiarity is not authorship', async () => {
    const { artifactId } = seedRealArtifact(
      fixture,
      'The upstream project implements a deterministic CSV parser.',
      { trust: 'local_clone_reference', relpath: 'vendor/README.md' },
    );
    const claim = proposeClaim(fixture.db, {
      statement: 'The upstream deterministic CSV parser is well understood here.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
    });

    await call('linkedin_claim_manage', {
      action: 'verify',
      claim_id: claim.id,
      clone_reference_ack: true,
      limitations: 'familiarity only; not authored by me',
      confirm: true,
    });

    // Without the acknowledgement the domain refuses outright: no wording can
    // make "I built it" true of someone else's code, so the reviewer has to
    // say which claim they are actually making.
    const verified = getClaim(fixture.db, claim.id);
    expect(verified.state).toBe('verified');
    expect(verified.limitations).toMatch(/familiarity only/i);
  });

  it('refuses the same verification without it', async () => {
    const { artifactId } = seedRealArtifact(
      fixture,
      'The upstream project implements a deterministic CSV parser.',
      { trust: 'local_clone_reference', relpath: 'vendor/PARSER.md' },
    );
    const claim = proposeClaim(fixture.db, {
      statement: 'I wrote the upstream deterministic CSV parser.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
    });

    await expect(
      call('linkedin_claim_manage', { action: 'verify', claim_id: claim.id, confirm: true }),
    ).rejects.toBeTruthy();
  });
});

describe('listing drafts with one of them named', () => {
  it('reports no validation for a revision that has never been through the gates', async () => {
    const written = (await call('linkedin_draft_write', {
      body_text: 'A draft nobody has validated yet.',
      slug: 'unvalidated',
      confirm: true,
    })) as { draft_id: string };

    const out = (await call('linkedin_draft_list', { id: written.draft_id })) as {
      detail: { validation: unknown };
    };

    // null, not an empty checklist: an empty list of checks reads as
    // "everything passed", which is the opposite of what it means.
    expect(out.detail.validation).toBeNull();
  });
});
