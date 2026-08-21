import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { proposeClaim, updateSection, verifyClaim } from '@linkedin-mcp/domain';
import { resourceDefs } from '../../linkedin-mcp-server/src/resources.ts';
import { createFixture, seedRealArtifact, type Fixture } from '../helpers/fixtures.ts';

// Resources are what a host attaches without spending a tool call, so their
// bodies are read far more often than any single tool result. They were
// previously only exercised over the wire as a name list — nothing asserted
// what the `read()` functions actually produce.

let fx: Fixture;

beforeEach(() => {
  fx = createFixture('resources');
});

afterEach(() => {
  fx.close();
});

const defs = () => resourceDefs({ db: fx.db, fts5: fx.fts5, home: fx.dir, actor: 'mcp_host' });
const byUri = (uri: string) => defs().find((d) => d.uri === uri)!;

describe('resource catalogue', () => {
  it('declares five private, TTL-bounded resources', () => {
    const all = defs();
    expect(all).toHaveLength(5);

    for (const def of all) {
      expect(def.uri.startsWith('linkedin://')).toBe(true);
      expect(def.name).not.toBe('');
      expect(def.title).not.toBe('');
      expect(def.description.length).toBeGreaterThan(20);
      // Everything here is the member's own data; a public cache scope would be
      // a disclosure bug, not a performance tweak.
      expect(def.cacheScope).toBe('private');
      expect(def.ttlMs).toBeGreaterThan(0);
    }
  });

  it('uses unique uris and names', () => {
    const all = defs();
    expect(new Set(all.map((d) => d.uri)).size).toBe(all.length);
    expect(new Set(all.map((d) => d.name)).size).toBe(all.length);
  });
});

describe('linkedin://profile/canonical', () => {
  it('renders every section, marking the ones never written', () => {
    const { text } = byUri('linkedin://profile/canonical').read();

    expect(text.startsWith('# Canonical profile')).toBe(true);
    expect(text).toContain('_(not written yet)_');
  });

  it('renders a written section with its revision and citation count', () => {
    const { artifactId } = seedRealArtifact(fx, 'Shipped a backup command.');
    const claim = proposeClaim(fx.db, {
      statement: 'Shipped a backup command with verified restore.',
      evidence: [{ artifact_id: artifactId, location: {} }],
      method: 'manual',
    });
    verifyClaim(fx.db, { claim_id: claim.id, confirm: true });
    const revision = updateSection(fx.db, {
      section_key: 'headline',
      content_text: 'Builds local-first tools',
      claim_ids: [claim.id],
      author: 'user',
      based_on_revision: null,
    });

    const { text } = byUri('linkedin://profile/canonical').read();
    expect(text).toContain('## headline');
    expect(text).toContain('Builds local-first tools');
    expect(text).toContain(`_revision ${revision.id}, 1 claims cited_`);
  });
});

describe('linkedin://positioning/brief', () => {
  it('covers exactly the three positioning sections', () => {
    const { text } = byUri('linkedin://positioning/brief').read();

    expect(text.startsWith('# Positioning brief')).toBe(true);
    for (const key of ['audiences', 'positioning_brief', 'keyword_map']) {
      expect(text).toContain(`## ${key}`);
    }
    // The canonical profile has more sections than these; the brief must not
    // quietly become a second copy of it.
    expect(text).not.toContain('## headline');
  });

  it('shows written positioning text once it exists', () => {
    updateSection(fx.db, {
      section_key: 'audiences',
      content_text: 'Engineering leaders at small product companies.',
      claim_ids: [],
      author: 'user',
      based_on_revision: null,
    });

    expect(byUri('linkedin://positioning/brief').read().text).toContain(
      'Engineering leaders at small product companies.',
    );
  });
});

describe('linkedin://capabilities', () => {
  it('serves the capability registry as parseable JSON', () => {
    const def = byUri('linkedin://capabilities');
    expect(def.mimeType).toBe('application/json');

    const parsed = JSON.parse(def.read().text) as Array<{ feature: string; status: string }>;
    expect(parsed.length).toBeGreaterThan(0);
    // A fresh home has no credential, and the registry must say so rather than
    // defaulting to available.
    expect(parsed.every((c) => c.status === 'unavailable')).toBe(true);
  });
});

describe('linkedin://voice/profile', () => {
  it('serves voice statistics as parseable JSON on an empty corpus', () => {
    const parsed = JSON.parse(byUri('linkedin://voice/profile').read().text) as {
      posts: number;
      language_mix: Record<string, number>;
      top_hashtags: unknown[];
    };
    expect(parsed.posts).toBe(0);
    expect(parsed.language_mix).toEqual({});
    expect(parsed.top_hashtags).toEqual([]);
  });
});

describe('linkedin://evidence/rules', () => {
  it('states the rules a drafting agent must not infer for itself', () => {
    const def = byUri('linkedin://evidence/rules');
    const { text } = def.read();

    // These are the load-bearing sentences. If one is edited away, the model
    // reading this resource loses the only place it is told.
    expect(text).toContain('Only VERIFIED claims');
    expect(text).toContain('limitations');
    expect(text).toContain('fabricated metrics');
    expect(text).toContain('local_clone_reference');
    expect(text).toContain('untrusted data');
    expect(text).toContain('human approval');
    // Cached for an hour: it is a constant, unlike everything else here.
    expect(def.ttlMs).toBe(3_600_000);
  });

  it('is a constant, so repeated reads are byte-identical', () => {
    const def = byUri('linkedin://evidence/rules');
    expect(def.read().text).toBe(def.read().text);
  });
});
