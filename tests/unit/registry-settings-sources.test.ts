import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';
import {
  enableSourceFromDashboard,
  getSetting,
  getSettingOrDefault,
  listSources,
  parseSettingValue,
  registerSource,
  registerVirtualSource,
  resolveDashboardPort,
  setSetting,
} from '@linkedin-mcp/domain';
import { validateToolRegistry, type ToolDef } from '../../linkedin-mcp-server/src/registry.ts';
import { createFixture, type Fixture } from '../helpers/fixtures.ts';

// Three small gatekeepers that each stop a different kind of nonsense.
//
// The registry check runs at boot over the whole catalog, so a tool that is
// wrong is a server that does not start rather than a host that discovers it at
// call time. Settings are a narrow allowlist because they change runtime safety
// behaviour and are reachable from MCP. And a source is the entry point for
// every byte in the product, so what it will accept as one matters.

let fixture: Fixture;
let evidence: string;

beforeEach(() => {
  fixture = createFixture('registry-settings');
  evidence = mkdtempSync(join(tmpdir(), 'linkedin-mcp-rss-'));
});

afterEach(() => {
  fixture.close();
  try {
    rmSync(evidence, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

function tool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: 'linkedin_example_tool',
    title: 'Example',
    description: 'Does an example thing.',
    inputSchema: z.object({}),
    outputSchema: z.object({}),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    permission: 'read-only',
    handler: async () => ({}),
    ...overrides,
  } as ToolDef;
}

describe('what the tool registry will accept', () => {
  it('accepts a well-formed tool', () => {
    expect(() => validateToolRegistry([tool()])).not.toThrow();
  });

  it('refuses a name outside the linkedin_ namespace', () => {
    // The prefix is what tells a host which server a tool belongs to when
    // several are connected at once.
    for (const name of ['claim_manage', 'LinkedIn_Claim', 'linkedin-claim', 'linkedin_Claim']) {
      expect(() => validateToolRegistry([tool({ name: name as never })]), name).toThrow(
        /invalid MCP tool name/,
      );
    }
  });

  it('refuses two tools with the same name', () => {
    // A host would call one of them and there is no way to say which.
    expect(() => validateToolRegistry([tool(), tool()])).toThrow(/duplicate MCP tool name/);
  });

  it('refuses a tool with nothing to describe it', () => {
    // The description is the only thing a model reads before deciding to call
    // it; an empty one is a tool that will be called for the wrong reasons.
    expect(() => validateToolRegistry([tool({ title: '  ' })])).toThrow(
      /needs a title and description/,
    );
    expect(() => validateToolRegistry([tool({ description: '' })])).toThrow(
      /needs a title and description/,
    );
  });

  it('refuses a tool that has not declared all four hints', () => {
    expect(() =>
      validateToolRegistry([
        tool({ annotations: { readOnlyHint: true, destructiveHint: false } as never }),
      ]),
    ).toThrow(/all four boolean annotations/);
  });

  it('refuses a tool claiming to be both read-only and destructive', () => {
    // A host that surfaces destructive tools behind a confirmation would let
    // this one through as a read, which is exactly backwards.
    expect(() =>
      validateToolRegistry([
        tool({
          annotations: {
            readOnlyHint: true,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
          },
        }),
      ]),
    ).toThrow(/cannot be both read-only and destructive/);
  });
});

describe('what settings will accept', () => {
  it('refuses a key that is not on the allowlist, wherever it is checked', () => {
    expect(() => parseSettingValue('anything.at.all', 1)).toThrow(/unknown setting/i);
    expect(() => setSetting(fixture.db, 'anything.at.all', 1, { confirm: true })).toThrow(
      /unknown setting/i,
    );
  });

  it('refuses a key that looks like a credential before anything else', () => {
    // Secrets go into the DPAPI vault through a human surface. A settings row
    // is plaintext in the database and readable over MCP.
    expect(() =>
      setSetting(fixture.db, 'linkedin.access_token', 'AQV-anything', { confirm: true }),
    ).toThrow(/secret-shaped/i);
  });

  it('stores and reads back a value that is in range', () => {
    setSetting(fixture.db, 'dashboard.port', 4791, { confirm: true });

    expect(getSetting(fixture.db, 'dashboard.port')).toBe(4791);
    expect(resolveDashboardPort(fixture.db)).toBe(4791);
  });

  it('refuses a stored row whose JSON cannot be read', () => {
    fixture.db.run(
      'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)',
      'dashboard.port',
      '{not json',
      new Date().toISOString(),
    );

    expect(() => getSetting(fixture.db, 'dashboard.port')).toThrow(/unreadable/i);
  });

  it('falls back to the default rather than failing a boot on a corrupt row', () => {
    fixture.db.run(
      'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)',
      'importer.max_file_mb',
      '"not a number"',
      new Date().toISOString(),
    );

    // This is read during every import. Throwing would make one bad row stop
    // the product rather than degrade one setting.
    expect(getSettingOrDefault(fixture.db, 'importer.max_file_mb', 50)).toBe(50);
  });

  it('still refuses to guess at a port it cannot read', () => {
    fixture.db.run(
      'INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)',
      'dashboard.port',
      '70000',
      new Date().toISOString(),
    );

    // The port is also the Host allowlist and the launch URL, so falling back
    // silently would print a URL nothing is listening on.
    expect(resolveDashboardPort(fixture.db)).toBe(4780);
  });
});

describe('what counts as a source', () => {
  it('refuses a virtual source with no label', () => {
    // The label is the only thing that distinguishes one upload batch from the
    // next; there is no path on disk to fall back on.
    expect(() =>
      registerVirtualSource(fixture.db, { origin: 'upload', label: '   ', trust: 'personal_doc' }),
    ).toThrow(/needs a label/i);
  });

  it('registers against a data home that does not exist yet', () => {
    // First run: the overlap check has nothing to compare against, and
    // refusing here would make the very first import impossible.
    const source = registerSource(fixture.db, {
      path: evidence,
      kind: 'folder',
      trust: 'personal_doc',
      label: 'documents',
      dataHome: join(fixture.dir, 'not-created-yet'),
    });

    expect(source.id).toMatch(/^src_/);
  });

  it('lists sources filtered by kind as well as by status', () => {
    registerVirtualSource(fixture.db, {
      origin: 'self_description',
      label: 'About me',
      trust: 'self_attested',
    });
    registerSource(fixture.db, {
      path: evidence,
      kind: 'folder',
      trust: 'personal_doc',
      label: 'documents',
      dataHome: fixture.dir,
    });

    const manual = listSources(fixture.db, { kind: 'manual' });
    const folders = listSources(fixture.db, { kind: 'folder' });

    expect(manual.every((s) => s.kind === 'manual')).toBe(true);
    expect(folders.every((s) => s.kind === 'folder')).toBe(true);
    expect(manual.length + folders.length).toBe(listSources(fixture.db).length);
  });

  it('refuses to re-enable one that was archived', () => {
    const source = registerVirtualSource(fixture.db, {
      origin: 'upload',
      label: 'an old batch',
      trust: 'personal_doc',
    });
    fixture.db.run("UPDATE sources SET status = 'archived' WHERE id = ?", source.id);

    // Archiving is how a member says "stop treating this as evidence". Letting
    // it come back would quietly return claims to the corpus they retired.
    expect(() => enableSourceFromDashboard(fixture.db, source.id)).toThrow(
      /archived sources cannot be re-enabled/i,
    );
  });
});
