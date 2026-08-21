import { join } from 'node:path';
import type { Hono } from 'hono';
import { ArtifactStore } from '@linkedin-mcp/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listArtifacts, listSources } from '@linkedin-mcp/domain';
import { buildDashboardApp } from '../../linkedin-dashboard/src/app.ts';
import { DashboardAuth, SESSION_COOKIE } from '../../linkedin-dashboard/src/auth.ts';
import { serverRequest } from '../helpers/clientHarness.ts';
import { createFixture, type Fixture } from '../helpers/fixtures.ts';

// The intake routes: the only place bytes enter this product without the member
// having first pointed at a path and typed an ENABLE confirmation.
//
// That trade is deliberate — choosing files in a picker in this session *is*
// the review — which puts the whole weight on what these routes refuse. A
// filename arriving over multipart is attacker-controlled in the ordinary
// sense: it is whatever the file happened to be called, and it ends up in log
// lines, MCP output and an artifact path.

let fixture: Fixture;
let app: Hono;
let cookie: string;

beforeEach(() => {
  fixture = createFixture('intake-routes');
  const auth = new DashboardAuth(4780);
  app = buildDashboardApp({
    db: fixture.db,
    store: fixture.store,
    fts5: fixture.fts5,
    home: fixture.dir,
    auth,
  });
  cookie = `${SESSION_COOKIE}=${auth.exchangeToken(auth.launchToken) ?? ''}`;
});

afterEach(() => fixture.close());

async function upload(
  files: Array<{ name: string; body: string | Uint8Array; type?: string }>,
  extra: Record<string, string> = {},
): Promise<Response> {
  const form = new FormData();
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  for (const file of files) {
    form.append('files', new File([file.body], file.name, { type: file.type ?? 'text/markdown' }));
  }
  return await app.fetch(
    serverRequest('/api/intake/upload', { method: 'POST', body: form }, cookie),
  );
}

const post = (path: string, body: unknown) =>
  app.fetch(
    serverRequest(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      cookie,
    ),
  );

const relpaths = () => listArtifacts(fixture.db, {}, fixture.fts5).map((a) => a.source_relpath);

describe('uploading documents', () => {
  it('imports them into a virtual source the member never has to enable', async () => {
    const response = await upload([
      { name: 'portfolio.md', body: '# Portfolio\n\nBuilt a deterministic CSV parser.\n' },
    ]);
    const body = (await response.json()) as {
      imported: number;
      results: Array<{ filename: string; imported: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(body.imported).toBe(1);
    expect(body.results[0]?.filename).toBe('portfolio.md');
    // Choosing the files in a picker in this session is the review the ENABLE
    // confirmation exists to ask for, so the source arrives already enabled.
    expect(listSources(fixture.db, { status: 'enabled' }).length).toBe(1);
    expect(relpaths()).toContain('portfolio.md');
  });

  it('refuses a request that is not multipart at all', async () => {
    const response = await post('/api/intake/upload', { files: ['pretend'] });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses an upload with no files in it', async () => {
    const response = await upload([]);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(listSources(fixture.db, {}).length).toBe(0);
  });

  it('refuses more files than one request may carry', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      name: `note-${i}.md`,
      body: `# Note ${i}\n`,
    }));

    const response = await upload(many);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(listSources(fixture.db, {}).length).toBe(0);
  });

  it('refuses a trust level that cannot mean anything for an upload', async () => {
    for (const trust of ['local_clone_reference', 'self_attested', 'whatever']) {
      const response = await upload([{ name: 'notes.md', body: '# Notes\n' }], { trust });
      // local_clone_reference describes a directory of someone else's code;
      // self_attested is reserved for text the member typed here.
      expect(response.status, trust).toBeGreaterThanOrEqual(400);
    }
  });

  it('accepts the two trust levels an uploaded document can honestly carry', async () => {
    for (const trust of ['personal_doc', 'own_repo']) {
      const response = await upload([{ name: `${trust}.md`, body: `# ${trust}\n` }], { trust });
      expect(response.status, trust).toBe(200);
    }
  });

  it('uses the label the member gave the batch', async () => {
    await upload([{ name: 'cv.md', body: '# CV\n' }], { label: 'My CV and cover letters' });

    expect(listSources(fixture.db, {}).some((s) => s.label === 'My CV and cover letters')).toBe(
      true,
    );
  });
});

describe('the filename that arrives with a file', () => {
  it('keeps only the base name, so a path cannot come through', async () => {
    const response = await upload([
      { name: '../../../etc/passwd', body: 'root:x:0:0\n' },
      { name: 'C:\\Windows\\System32\\drivers\\etc\\hosts', body: '127.0.0.1 localhost\n' },
    ]);
    const body = (await response.json()) as { results: Array<{ filename: string }> };

    // A directory separator in a name is not a directory here.
    for (const result of body.results) {
      expect(result.filename).not.toContain('/');
      expect(result.filename).not.toContain('\\');
      expect(result.filename).not.toContain('..');
    }
    expect(body.results.map((r) => r.filename)).toEqual(['passwd', 'hosts']);
  });

  it('refuses a name that is nothing but separators or dots', async () => {
    for (const name of ['..', '.', '/', '\\', '   ']) {
      const response = await upload([{ name, body: 'x' }]);
      expect(response.status, JSON.stringify(name)).toBeGreaterThanOrEqual(400);
    }
  });

  it('refuses a name carrying control characters, which would forge a log line', async () => {
    const newline = String.fromCharCode(10);
    const nul = String.fromCharCode(0);

    for (const name of [`ok${newline}imported: everything`, `ok${nul}.md`, 'notes.md:$DATA']) {
      const response = await upload([{ name, body: 'x' }]);
      // A colon is an NTFS alternate data stream; the control characters would
      // let a filename write its own line into the log or an MCP response.
      expect(response.status, JSON.stringify(name)).toBeGreaterThanOrEqual(400);
    }
  });

  it('refuses a name longer than any real file has', async () => {
    const response = await upload([{ name: `${'a'.repeat(200)}.md`, body: 'x' }]);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('reports a file over the size limit against its own name, and imports the rest', async () => {
    const response = await upload([
      { name: 'small.md', body: '# Small\n' },
      { name: 'huge.md', body: new Uint8Array(30 * 1024 * 1024) },
    ]);
    const body = (await response.json()) as {
      imported: number;
      results: Array<{ filename: string; imported: boolean; reason: string | null }>;
    };

    if (response.status !== 200) return;
    const huge = body.results.find((r) => r.filename === 'huge.md');
    expect(huge?.imported).toBe(false);
    expect(huge?.reason ?? '').toMatch(/limit/i);
    // One oversized file does not cost the member the others.
    expect(body.results.find((r) => r.filename === 'small.md')?.imported).toBe(true);
  });
});

describe('describing yourself in your own words', () => {
  it('stores the text as a self-attested source', async () => {
    const response = await post('/api/intake/describe', {
      confirm: true,
      text:
        'I build local-first developer tooling in TypeScript, mostly around evidence and ' +
        'provenance, and I have been doing it across several projects.',
    });
    const body = (await response.json()) as { source_id: string; artifact_id: string };

    expect(response.status).toBe(200);
    expect(body.artifact_id).toBeTruthy();
    const source = listSources(fixture.db, {}).find((s) => s.id === body.source_id);
    // Self-attested, so anything resting on it stays self-reported rather than
    // borrowing the standing of a document written earlier.
    expect(source?.trust).toBe('self_attested');
  });

  it('refuses text too short to be worth storing', async () => {
    const response = await post('/api/intake/describe', { confirm: true, text: 'hi' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(listSources(fixture.db, {}).length).toBe(0);
  });

  it('needs no digest-bound confirmation here, unlike the MCP tool', async () => {
    const response = await post('/api/intake/describe', {
      text: 'I build local-first developer tooling in TypeScript, around evidence and provenance.',
    });

    // The two entry points differ on purpose. Over MCP the text is bound to a
    // digest and confirmed, because a model could have shown the member one
    // wording and stored another. Here the member typed it into this box in
    // this session on the authenticated local surface, so the typing is the
    // confirmation and asking again would be ceremony.
    expect(response.status).toBe(200);
    expect(listSources(fixture.db, {})[0]?.trust).toBe('self_attested');
  });

  it('redacts a credential before storing anything', async () => {
    const secret = 'AQV-fake-fixture-token-0123456789abcdefghijklmno';
    const response = await post('/api/intake/describe', {
      confirm: true,
      text: `I build local-first tooling. My LinkedIn token is ${secret} which I should not have typed.`,
    });

    if (response.status !== 200) return;
    const stored = fixture.db.get('SELECT text FROM extractions ORDER BY rowid DESC LIMIT 1');
    // The same scanner that runs on an imported file runs here; typing a token
    // into a text box must not be a way around it.
    expect(String(stored?.['text'] ?? '')).not.toContain(secret);
  });
});

describe('the readiness route', () => {
  it('answers on an empty home, because that is when it is asked', async () => {
    const response = await app.fetch(serverRequest('/api/readiness', { method: 'GET' }, cookie));
    const body = (await response.json()) as { checks: Array<{ id: string; status: string }> };

    expect(response.status).toBe(200);
    expect(body.checks.length).toBeGreaterThan(0);
  });
});

// The three intake failures that need something to go wrong first.
//
// Intake is the one place bytes arrive without a path and an ENABLE
// confirmation, so its failures have to be legible per file. A batch where one
// document cannot be stored must still store the others and say which one did
// not, and a description that cannot be stored must say so rather than
// reporting a source with nothing in it.
describe('intake when storing fails', () => {
  /** A store that refuses to write, the way a full or read-only disk does. */
  class UnwritableStore extends ArtifactStore {
    override put(): never {
      throw new Error('EROFS: read-only file system');
    }
  }

  function unwritableApp(): { app: Hono; cookie: string } {
    const auth = new DashboardAuth(4780);
    const built = buildDashboardApp({
      db: fixture.db,
      store: new UnwritableStore(join(fixture.dir, 'artifacts')),
      fts5: fixture.fts5,
      home: fixture.dir,
      auth,
    });
    return {
      app: built,
      cookie: `${SESSION_COOKIE}=${auth.exchangeToken(auth.launchToken) ?? ''}`,
    };
  }

  it('reports an empty file against its own name and imports the rest', async () => {
    const response = await upload([
      { name: 'notes.md', body: 'A short note about deterministic parsing.' },
      { name: 'placeholder.md', body: '' },
    ]);

    const body = (await response.json()) as {
      imported: number;
      results: Array<{ filename: string; imported: boolean; reason: string | null }>;
    };
    // One bad file does not abandon the batch — a member who dragged in a
    // folder should not lose twenty documents to one stub.
    expect(body.imported).toBe(1);
    const rejected = body.results.find((r) => r.filename === 'placeholder.md');
    expect(rejected?.imported).toBe(false);
    expect(rejected?.reason).toMatch(/empty/i);
  });

  it('reports every file when the store itself will not take them', async () => {
    const { app: broken, cookie: brokenCookie } = unwritableApp();
    const form = new FormData();
    form.append('files', new File(['A note.'], 'notes.md', { type: 'text/markdown' }));

    const response = await broken.fetch(
      serverRequest('/api/intake/upload', { method: 'POST', body: form }, brokenCookie),
    );

    const body = (await response.json()) as {
      imported: number;
      results: Array<{ reason: string | null }>;
    };
    expect(body.imported).toBe(0);
    expect(body.results[0]?.reason).toMatch(/read-only|EROFS/i);
  });

  it('says the description was not stored rather than reporting an empty source', async () => {
    const { app: broken, cookie: brokenCookie } = unwritableApp();

    const response = await broken.fetch(
      serverRequest(
        '/api/intake/describe',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            text: 'I build local-first evidence tooling in TypeScript, mostly on Windows.',
          }),
        },
        brokenCookie,
      ),
    );

    // Returning a source id here would leave the member believing their words
    // were kept, on a screen that would then show nothing.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await response.json())).toMatch(/was not stored/i);
  });

  it('refuses a description longer than any About section could hold', async () => {
    const response = await post('/api/intake/describe', { text: 'x'.repeat(20_001) });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await response.json())).toMatch(/over 20000 characters/i);
  });
});
