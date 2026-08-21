import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod/v4';
import type { Row, SqlValue, SqliteDriver } from '@linkedin-mcp/db';
import {
  compareCohorts,
  getSettingOrDefault,
  listDrafts,
  listFeatureControls,
  pickLocalized,
  probeLane,
  upsertPillar,
  writeDraft,
} from '@linkedin-mcp/domain';
import { createAssetProvider } from '../../linkedin-dashboard/src/assets.ts';
import { invokeDashboardTool } from '../../linkedin-mcp-server/src/dashboardBridge.ts';
import { featureForTool } from '../../linkedin-mcp-server/src/featureRouting.ts';
import type { ToolDef } from '../../linkedin-mcp-server/src/registry.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// The last handful of guards, each of which exists because something upstream
// could be wrong in a way that would otherwise pass silently.

let fixture: Fixture;
let seeded: ReturnType<typeof seedHealthy>;
let dir: string;

beforeEach(() => {
  fixture = createFixture('remainder-units');
  seeded = seedHealthy(fixture);
  dir = mkdtempSync(join(tmpdir(), 'linkedin-mcp-rem-'));
});

function writeBuild(js: string): void {
  writeFileSync(join(dir, 'app.js'), js, 'utf8');
  writeFileSync(join(dir, 'app.css'), ':root { color-scheme: light dark; }', 'utf8');
  writeFileSync(join(dir, 'theme-boot.js'), 'document.documentElement.dataset.theme;', 'utf8');
}

afterEach(() => {
  vi.unstubAllGlobals();
  fixture.close();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

describe('reading a setting when the database itself fails', () => {
  it('lets the real failure through instead of quietly using the default', () => {
    const broken: SqliteDriver = {
      exec: (sql: string) => fixture.db.exec(sql),
      run: (sql: string, ...params: SqlValue[]) => fixture.db.run(sql, ...params),
      all: (sql: string, ...params: SqlValue[]): Row[] => fixture.db.all(sql, ...params),
      backupTo: (dest: string) => fixture.db.backupTo(dest),
      close: () => {},
      get: (): Row | undefined => {
        throw new Error('the database file is on a disconnected drive');
      },
    };

    // The fallback exists for one thing: a stored value this build cannot
    // parse. Swallowing a dead database too would hide the real fault behind a
    // product that looks like it is working on defaults.
    expect(() => getSettingOrDefault(broken, 'importer.max_file_mb', 50)).toThrow(
      /disconnected drive/,
    );
  });
});

describe('the feature overrides row', () => {
  it('fails closed when the stored value is not an object of switches', () => {
    fixture.db.run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
      'features.enabled',
      '["evidence","profile"]',
      new Date().toISOString(),
    );

    // Falling back to the defaults would silently re-enable groups the member
    // deliberately switched off, so policy state fails closed instead.
    expect(() => listFeatureControls(fixture.db)).toThrow(/unreadable/i);
  });
});

describe('comparing two cohorts', () => {
  it('refuses cohorts that share a post', () => {
    // Repeating one post id twelve times used to produce n=12 and promote the
    // honesty label from 'anecdote' to 'moderate'. The label exists precisely
    // to stop that kind of self-deception.
    expect(() =>
      compareCohorts(fixture.db, {
        metric: 'impressions',
        cohort_a: ['pub_1', 'pub_2'],
        cohort_b: ['pub_2', 'pub_3'],
      }),
    ).toThrow(/disjoint/i);
  });

  it('refuses a comparison with an empty side', () => {
    expect(() =>
      compareCohorts(fixture.db, { metric: 'impressions', cohort_a: [], cohort_b: ['pub_1'] }),
    ).toThrow(/at least one/i);
  });
});

describe('listing drafts by pillar', () => {
  it('returns only the drafts filed under it', () => {
    const pillar = upsertPillar(fixture.db, { name: 'Evidence tooling' });
    const { draft } = writeDraft(fixture.db, {
      body_text: 'A draft filed under a pillar.',
      slug: 'filed',
      pillar_id: pillar.id,
    });

    const filed = listDrafts(fixture.db, { pillar_id: pillar.id });

    // Pillars are how a member plans a mix rather than a pile, so a filter that
    // returned everything would make the plan meaningless.
    expect(filed.map((d) => d.id)).toEqual([draft.id]);
    expect(listDrafts(fixture.db, {}).length).toBeGreaterThan(filed.length);
  });
});

describe('probing a lane when the transport gives out', () => {
  it('calls it retryable rather than blaming the credential', async () => {
    // Nothing leaves the machine: the socket is replaced, not LinkedIn.
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });

    const result = await probeLane('write', 'AQV-fake-fixture-token-not-a-real-credential-01234');

    // A DNS failure, a socket reset or a TLS error says nothing about the
    // token. Demotion is what requireCapability reads, so treating a blip as a
    // revocation closes a working lane until someone re-verifies by hand.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(true);
    expect(result.status).toBe(0);
  }, 30_000);
});

describe('a probe that fails outside the client', () => {
  it('is still retryable, because a body that will not read says nothing about the token', async () => {
    // Not an HTTP failure and not a DomainError: the response arrived and its
    // body could not be read. Treating that as a revoked credential would close
    // a working lane over a transport hiccup.
    vi.stubGlobal('fetch', async () => ({
      url: '',
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => {
        throw new TypeError('body already used');
      },
    }));

    const result = await probeLane('write', 'AQV-fake-fixture-token-not-a-real-credential-01234');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.retryable).toBe(true);
    expect(result.message).toMatch(/body already used/i);
  }, 30_000);
});

describe('picking a localized value', () => {
  it('reads a plain string as itself', () => {
    expect(pickLocalized('An old headline')).toBe('An old headline');
  });

  it('answers null for anything that is not a localized shape', () => {
    // There is no implicit en_US anywhere in this mapping: guessing one would
    // hand a member whose profile is only in their own language an empty
    // string and call it their headline.
    for (const value of [null, 42, [], { localized: 'not an object' }, { localized: null }, {}]) {
      expect(pickLocalized(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('reads the entry for the locale that was asked for', () => {
    expect(pickLocalized({ localized: { en_US: 'Engineer', nl_NL: 'Ingenieur' } }, 'nl_NL')).toBe(
      'Ingenieur',
    );
  });
});

describe('routing a tool to its feature group', () => {
  it('leaves the two reporting tools ungated', () => {
    // A tool whose whole job is reporting what is switched off must not be
    // switchable off, or a member who narrows an agent's reach also removes the
    // way to find out why nothing works.
    expect(featureForTool('linkedin_feature_control')).toBeNull();
    expect(featureForTool('linkedin_readiness_check')).toBeNull();
  });

  it('groups by prefix when there is no exact entry', () => {
    expect(featureForTool('linkedin_claim_list')).toBe('evidence');
    expect(featureForTool('linkedin_snapshot_import')).toBe('profile');
    expect(featureForTool('linkedin_draft_write')).toBe('content');
  });

  it('refuses a name it cannot place', () => {
    // Falling back to "ungated" would let a new tool escape every switch
    // silently; this is a build-time mistake and it fails loudly.
    expect(() => featureForTool('linkedin_something_new')).toThrow(/no shared feature group/);
  });
});

describe('a tool that answers with the wrong shape', () => {
  it('is refused rather than handed to the dashboard', async () => {
    const tool = {
      name: 'linkedin_broken_tool',
      title: 'Broken',
      description: 'Answers with something else.',
      inputSchema: z.object({}),
      outputSchema: z.object({ count: z.number() }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'read-only',
      handler: async () => ({ count: 'not a number' }),
    } as unknown as ToolDef;

    // The output schema is what the dashboard renders against. A mismatch
    // reaching the screen is a blank panel with no explanation.
    await expect(invokeDashboardTool(tool, {})).rejects.toThrow(/does not match its output schema/);
  });

  it('names the field when the input is wrong', async () => {
    const tool = {
      name: 'linkedin_strict_tool',
      title: 'Strict',
      description: 'Wants a number.',
      inputSchema: z.object({ count: z.number() }),
      outputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      permission: 'read-only',
      handler: async () => ({}),
    } as unknown as ToolDef;

    const failure = await invokeDashboardTool(tool, { count: 'ten' }).catch((e: unknown) => e);
    expect(JSON.stringify(failure)).toContain('count');
  });
});

describe('serving a client asset twice', () => {
  it('answers the second read from the cache', () => {
    writeBuild('console.log("hello");');
    const provider = createAssetProvider(dir, { watch: false });

    const first = provider.resolve(provider.manifest()['app.js']);
    const second = provider.resolve(provider.manifest()['app.js']);

    // The dashboard is a loopback server on a member's own machine; re-reading
    // and re-hashing every asset on every request would be work for nothing.
    expect(second).toBe(first);
    expect(first?.hash).toHaveLength(16);
  });

  it('re-reads a changed asset while watching, and keeps an unchanged one', () => {
    writeBuild('console.log("one");');
    const provider = createAssetProvider(dir, { watch: true });
    const first = provider.manifest()['app.js'];

    expect(provider.manifest()['app.js']).toBe(first);

    writeFileSync(join(dir, 'app.js'), 'console.log("two but longer");', 'utf8');
    // tsup rebuilds the client without restarting the server in development,
    // so a stale bundle would be served until someone noticed.
    expect(provider.manifest()['app.js']).not.toBe(first);
  });

  it('refuses to start at all when part of the build is missing', () => {
    writeFileSync(join(dir, 'app.js'), 'console.log("only one of three");', 'utf8');

    // Eager, so a partial build fails at startup with an actionable message
    // rather than on the first page load.
    expect(() => createAssetProvider(dir, { watch: false })).toThrow(/not found/i);
  });

  it('404s a request carrying a stale hash rather than serving new bytes', () => {
    writeBuild('console.log("one");');
    const provider = createAssetProvider(dir, { watch: false });

    // Asset URLs are immutable by contract; serving different bytes under an
    // old one would leave a browser caching the wrong build forever.
    expect(provider.resolve('app.deadbeefdeadbeef.js')).toBeNull();
    expect(provider.resolve(provider.manifest()['app.js'])).not.toBeNull();
  });
});

describe('the seeded corpus', () => {
  it('is still readable after all of that', () => {
    expect(seeded.artifactId).toMatch(/^art_/);
  });
});
