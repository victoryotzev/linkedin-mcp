import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '@linkedin-mcp/db';
import {
  denyApproval,
  listArtifacts,
  listDrafts,
  requestApproval,
  validateDraft,
  writeDraft,
} from '@linkedin-mcp/domain';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The last of the domain units: the content-addressed store, artifact search,
// draft state, link checking and the one-live-approval rule.

let fixture: Fixture;
let seeded: ReturnType<typeof seedHealthy>;
let scratch: string;

beforeEach(() => {
  fixture = createFixture('domain-units');
  seeded = seedHealthy(fixture);
  scratch = mkdtempSync(join(tmpdir(), 'linkedin-mcp-cas-'));
});

afterEach(() => {
  fixture.close();
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

describe('the content-addressed store', () => {
  it('writes bytes once and reports a second write as already present', () => {
    const store = new ArtifactStore(join(scratch, 'artifacts'));
    const bytes = new TextEncoder().encode('the same bytes');

    const first = store.put(bytes);
    const second = store.put(bytes);

    // Same bytes, same address: this is what stops a re-import inflating how
    // much evidence a member appears to have.
    expect(second.sha256).toBe(first.sha256);
    expect(first.existed).toBe(false);
    expect(second.existed).toBe(true);
  });

  it('writes the file read-only, so nothing edits evidence in place', () => {
    const store = new ArtifactStore(join(scratch, 'artifacts'));
    const { path } = store.put(new TextEncoder().encode('evidence'));

    expect(existsSync(path)).toBe(true);
    // An artifact is what a claim points at. Leaving it writable would let the
    // bytes under a verified claim change without anything noticing.
    expect(() => writeFileSync(path, 'rewritten')).toThrow();
    chmodSync(path, 0o644);
  });

  it('reads back exactly what was written', () => {
    const store = new ArtifactStore(join(scratch, 'artifacts'));
    const original = 'A line with a — dash and an é.';
    const { sha256 } = store.put(new TextEncoder().encode(original));

    expect(new TextDecoder().decode(store.read(sha256))).toBe(original);
  });

  it('treats a file another writer put there first as already present', () => {
    const root = join(scratch, 'artifacts');
    const store = new ArtifactStore(root);
    const bytes = new TextEncoder().encode('raced bytes');
    const { sha256, path } = store.put(bytes);

    // A second process with identical content-addressed bytes wins the rename
    // race; the loser has to accept the winner's file rather than fail.
    const again = new ArtifactStore(root).put(bytes);
    expect(again.existed).toBe(true);
    expect(again.sha256).toBe(sha256);
    expect(readFileSync(path).toString()).toBe('raced bytes');
  });

  it('refuses a hash that is not one', () => {
    const store = new ArtifactStore(join(scratch, 'artifacts'));
    for (const bad of ['', 'nope', '../escape', 'a'.repeat(63), `${'a'.repeat(64)}x`]) {
      expect(() => store.read(bad), bad).toThrow();
    }
  });
});

describe('searching artifacts', () => {
  const search = (q: string) => listArtifacts(fixture.db, { q }, fixture.fts5);

  it('finds one by text inside it', () => {
    expect(search('hash-chained').length).toBeGreaterThan(0);
  });

  it('returns nothing rather than everything for a term with no match', () => {
    expect(search('zzzz-nothing-says-this')).toEqual([]);
  });

  it('treats LIKE wildcards as literal characters', () => {
    const all = listArtifacts(fixture.db, {}, fixture.fts5);
    // A bare % must not match every artifact.
    expect(search('%').length).toBeLessThan(all.length);
    expect(search('_').length).toBeLessThan(all.length);
  });

  it('filters by source and by media type', () => {
    const sourceId = String(
      fixture.db.get('SELECT source_id FROM artifacts LIMIT 1')?.['source_id'],
    );
    const bySource = listArtifacts(fixture.db, { source_id: sourceId }, fixture.fts5);
    expect(bySource.length).toBeGreaterThan(0);
    for (const artifact of bySource) expect(artifact.source_id).toBe(sourceId);

    const byMime = listArtifacts(fixture.db, { mime: 'text/markdown' }, fixture.fts5);
    for (const artifact of byMime) expect(artifact.mime).toBe('text/markdown');

    expect(listArtifacts(fixture.db, { mime: 'application/nothing' }, fixture.fts5)).toEqual([]);
  });
});

describe('writing a draft', () => {
  it('refuses media that does not exist', () => {
    expect(() =>
      writeDraft(fixture.db, {
        body_text: 'A post with a picture.',
        media: [{ artifact_id: 'art_nope', alt: 'a picture' }],
      }),
    ).toThrow(/not found/i);
  });

  it('accepts media that does', () => {
    const { draft } = writeDraft(fixture.db, {
      body_text: 'A post with a picture.',
      media: [{ artifact_id: seeded.artifactId, alt: 'the README' }],
    });

    expect(draft.id).toMatch(/^drf_/);
  });

  it('refuses to edit a draft that has been published', () => {
    fixture.db.run("UPDATE post_drafts SET state = 'published' WHERE id = ?", seeded.draftId);

    expect(() =>
      writeDraft(fixture.db, { draft_id: seeded.draftId, body_text: 'Second thoughts.' }),
    ).toThrow(/published/i);
  });

  it('refuses to edit an abandoned one', () => {
    fixture.db.run("UPDATE post_drafts SET state = 'abandoned' WHERE id = ?", seeded.draftId);

    expect(() =>
      writeDraft(fixture.db, { draft_id: seeded.draftId, body_text: 'Second thoughts.' }),
    ).toThrow(/abandoned/i);
  });

  it('derives a slug from the body when none is given', () => {
    const { draft } = writeDraft(fixture.db, {
      body_text: 'A post about renovating deployed software rather than rewriting it.',
    });

    expect(draft.slug.length).toBeGreaterThan(0);
    expect(draft.slug).not.toContain(' ');
  });

  it('bounds the list by default, and filters it', () => {
    const all = listDrafts(fixture.db, {});
    expect(all.length).toBeGreaterThan(0);

    const bounded = listDrafts(fixture.db, { limit: 1 });
    expect(bounded.length).toBe(1);

    // The dashboard runs a validation lookup per returned draft, so an
    // unbounded list made one screen cost a query per draft ever written.
    for (const draft of listDrafts(fixture.db, { state: 'draft' })) {
      expect(draft.state).toBe('draft');
    }
  });
});

describe('link checking in a draft', () => {
  const linkCheck = (body: string) => {
    const { draft } = writeDraft(fixture.db, { body_text: body });
    return validateDraft(fixture.db, draft.id).checks.find((c) => c.check === 'link_format');
  };

  it('passes a plain https link', () => {
    expect(linkCheck('The project contains 181 test files. https://example.com/x')?.passed).toBe(
      true,
    );
  });

  it('passes a link with trailing punctuation, which is a sentence, not a URL', () => {
    expect(
      linkCheck('The project contains 181 test files. See https://example.com/x.')?.passed,
    ).toBe(true);
  });

  it('fails a link the URL parser rejects', () => {
    // A broken link on a public post is a small permanent embarrassment, and
    // catching it costs nothing. An unterminated IPv6 bracket is one of the few
    // shapes that both survives the whitespace-delimited match and fails to
    // parse.
    expect(
      linkCheck('The project contains 181 test files. See https://[ for details.')?.passed,
    ).toBe(false);
  });

  it('accepts a URL whose host merely looks odd, because it is still a URL', () => {
    expect(linkCheck('The project contains 181 test files. https://not/a/real/host')?.passed).toBe(
      true,
    );
  });
});

describe('the one-live-approval rule', () => {
  it('refuses a second approval while one is still live', () => {
    // The seeded draft already has a pending approval.
    expect(() => requestApproval(fixture.db, { draft_id: seeded.draftId })).toThrow(
      /already has a live approval/i,
    );
  });

  it('allows another once the first is settled', () => {
    denyApproval(fixture.db, seeded.approvalId, 'not this week', 'dashboard');

    const { approval } = requestApproval(fixture.db, { draft_id: seeded.draftId });
    expect(approval.state).toBe('pending');
  });

  it('refuses to deny an approval that is already decided', () => {
    denyApproval(fixture.db, seeded.approvalId, 'not this week', 'dashboard');

    expect(() => denyApproval(fixture.db, seeded.approvalId, 'again', 'dashboard')).toThrow(
      /denied/i,
    );
  });
});
