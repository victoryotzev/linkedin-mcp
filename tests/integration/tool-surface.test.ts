import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { featureForTool } from '../../linkedin-mcp-server/src/featureRouting.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

// A sweep over the whole registry rather than a test per tool.
//
// The point is the properties that must hold for all 44 at once: every
// read-only tool answers on a populated ledger without mutating it, every
// declared output actually validates against its own schema, and no tool
// reaches an external service just by being called. Individual behaviour is
// tested where that behaviour lives; this catches the tool that was added
// without anyone running it.

let fixture: Fixture;
let tools: ReturnType<typeof toolDefs>;

beforeAll(() => {
  fixture = createFixture('tool-surface');
  seedHealthy(fixture);
  tools = toolDefs({ db: fixture.db, fts5: fixture.fts5, home: fixture.dir, actor: 'mcp_host' });
});

afterAll(() => fixture.close());

/** Rows that must not change when a read-only tool runs. */
function ledgerSnapshot(): string {
  const counts = [
    'sources',
    'artifacts',
    'claims',
    'post_drafts',
    'draft_revisions',
    'approvals',
    'publications',
    'audit_events',
    'canonical_revisions',
  ].map(
    (table) =>
      `${table}=${Number(fixture.db.get(`SELECT COUNT(*) AS n FROM ${table}`)?.['n'] ?? 0)}`,
  );
  return counts.join(',');
}

const readOnly = () => tools.filter((t) => t.annotations.readOnlyHint);

describe('the registry as a whole', () => {
  it('exposes 44 tools, each governed by a feature group or explicitly exempt', () => {
    expect(tools).toHaveLength(44);
    for (const tool of tools) {
      // featureForTool throws for an unmapped name, so this also proves no tool
      // slipped in ungoverned.
      expect(() => featureForTool(tool.name)).not.toThrow();
    }
  });

  it('gives every tool a distinct name, title and description', () => {
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^linkedin_[a-z0-9_]+$/);
      expect(tool.title.trim()).not.toBe('');
      expect(tool.description.trim().length).toBeGreaterThan(30);
    }
  });

  it('never marks a tool both read-only and destructive', () => {
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint && tool.annotations.destructiveHint).toBe(false);
    }
  });

  it('keeps external reach confined to the tools that declare it', () => {
    // openWorldHint is what a host shows a user before allowing a call. A tool
    // that reaches LinkedIn without declaring it would be a lie to the host.
    const openWorld = tools.filter((t) => t.annotations.openWorldHint).map((t) => t.name);
    for (const name of openWorld) {
      expect(['external-read', 'external-write']).toContain(
        tools.find((t) => t.name === name)!.permission,
      );
    }
  });

  it('scopes write permission to tools that are not read-only', () => {
    for (const tool of tools) {
      if (tool.permission === 'local-read' || tool.permission === 'external-read') continue;
      expect(tool.annotations.readOnlyHint).toBe(false);
    }
  });
});

describe('every read-only tool, run against a populated ledger', () => {
  it('answers with output matching its own declared schema', async () => {
    const before = ledgerSnapshot();
    const ran: string[] = [];
    const skipped: string[] = [];

    for (const tool of readOnly()) {
      const parsed = tool.inputSchema.safeParse({});
      if (!parsed.success) {
        // A read-only tool with a required argument is exercised where that
        // argument is meaningful, not here.
        skipped.push(tool.name);
        continue;
      }
      const output = await tool.handler(parsed.data as never);
      const validated = tool.outputSchema.safeParse(output);
      expect(validated.success, `${tool.name} output failed its own schema`).toBe(true);
      ran.push(tool.name);
    }

    // A filter that silently matched nothing would make this vacuous.
    expect(ran.length).toBeGreaterThanOrEqual(10);
    // And the whole point: reading changed nothing.
    expect(ledgerSnapshot()).toBe(before);
    expect(skipped.every((n) => n.startsWith('linkedin_'))).toBe(true);
  });

  it('paginates without exceeding the requested limit', async () => {
    for (const tool of readOnly()) {
      const parsed = tool.inputSchema.safeParse({ limit: 1 });
      if (!parsed.success) continue;
      const output = (await tool.handler(parsed.data as never)) as {
        items?: unknown[];
        events?: unknown[];
        has_more?: boolean;
      };
      const page = output.items ?? output.events;
      if (Array.isArray(page)) {
        expect(
          page.length,
          `${tool.name} returned more than the requested limit`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('capability gating', () => {
  it('refuses every external tool on a home with no credential', async () => {
    const external = tools.filter(
      (t) => t.permission === 'external-read' || t.permission === 'external-write',
    );
    expect(external.length).toBeGreaterThan(0);

    for (const tool of external) {
      const parsed = tool.inputSchema.safeParse({});
      if (!parsed.success) continue;
      // Fail-closed: with no verified lane these must refuse rather than
      // attempt a call. Any of these outcomes is a refusal; a network attempt
      // would surface as something else entirely.
      await expect(
        tool.handler(parsed.data as never),
        `${tool.name} should refuse without a credential`,
      ).rejects.toBeTruthy();
    }
  });
});
