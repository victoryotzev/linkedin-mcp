import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '@linkedin-mcp/db';
import { appendAuditEvent } from '@linkedin-mcp/domain';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { createDashboardToolCatalog } from '../../linkedin-mcp-server/src/dashboardBridge.ts';
import { sortTools, validateToolRegistry } from '../../linkedin-mcp-server/src/registry.ts';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

describe('MCP tool registry contract', () => {
  it('is unique, deterministic, fully annotated, and runtime-valid', () => {
    const home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-registry-'));
    dirs.push(home);
    const { db, fts5 } = openDatabase(join(home, 'registry.sqlite3'));
    try {
      migrate(db);
      const tools = toolDefs({ db, fts5, home, actor: 'mcp_host' });
      const dashboardTools = createDashboardToolCatalog({ db, fts5, home, actor: 'dashboard' });
      expect(() => validateToolRegistry(tools)).not.toThrow();
      expect(tools).toHaveLength(44);
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
      expect(dashboardTools.map((tool) => tool.name)).toEqual(
        [...tools.map((tool) => tool.name)].sort((a, b) => a.localeCompare(b)),
      );
      expect(sortTools(tools).map((tool) => tool.name)).toEqual(
        [...tools.map((tool) => tool.name)].sort((a, b) => a.localeCompare(b)),
      );
      for (const tool of tools) {
        expect(Object.keys(tool.annotations).sort()).toEqual([
          'destructiveHint',
          'idempotentHint',
          'openWorldHint',
          'readOnlyHint',
        ]);
        expect(tool.inputSchema).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
      }
    } finally {
      db.close();
    }
  });

  it('keeps audit pages stable when a newer event is appended between requests', async () => {
    const home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-audit-page-'));
    dirs.push(home);
    const { db, fts5 } = openDatabase(join(home, 'registry.sqlite3'));
    try {
      migrate(db);
      for (const subject of ['one', 'two', 'three']) {
        appendAuditEvent(db, {
          event_type: 'test.event',
          actor: 'system',
          subject_type: 'test',
          subject_id: subject,
        });
      }
      const tool = toolDefs({ db, fts5, home, actor: 'mcp_host' }).find(
        (candidate) => candidate.name === 'linkedin_audit_query',
      );
      expect(tool).toBeDefined();
      const first = (await tool!.handler({ limit: 1, verify_chain: false } as never)) as {
        events: Array<{ subject_id: string | null }>;
        next_cursor?: string;
      };
      expect(first.events[0]?.subject_id).toBe('three');

      appendAuditEvent(db, {
        event_type: 'test.event',
        actor: 'system',
        subject_type: 'test',
        subject_id: 'newest',
      });
      const second = (await tool!.handler({
        limit: 1,
        verify_chain: false,
        cursor: first.next_cursor,
      } as never)) as { events: Array<{ subject_id: string | null }> };
      expect(second.events[0]?.subject_id).toBe('two');
    } finally {
      db.close();
    }
  });
});
