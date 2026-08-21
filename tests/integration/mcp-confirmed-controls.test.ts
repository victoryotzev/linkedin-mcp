import { afterEach, describe, expect, it } from 'vitest';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { createFixture, seedHealthy, type Fixture } from '../helpers/fixtures.ts';

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

describe('confirmed MCP control operations', () => {
  it('refuses real publishing without both the exact command and enabled feature', async () => {
    const fixture = createFixture('mcp-live-publish-control');
    fixtures.push(fixture);
    const seeded = seedHealthy(fixture);
    const tool = toolDefs({
      db: fixture.db,
      fts5: fixture.fts5,
      home: fixture.dir,
      actor: 'mcp_host',
    }).find((candidate) => candidate.name === 'linkedin_publish_execute')!;

    await expect(
      tool.handler({
        approval_id: seeded.approvalId,
        adapter: 'linkedin',
        command: 'PUBLISH wrong-id',
        confirm: true,
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', blockers: ['confirmation_required'] });
    await expect(
      tool.handler({
        approval_id: seeded.approvalId,
        adapter: 'linkedin',
        command: `PUBLISH ${seeded.approvalId}`,
        confirm: true,
      } as never),
    ).rejects.toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      blockers: ['feature_disabled:live_publishing'],
    });
  });

  it('enables a reviewed evidence source only with its exact command', async () => {
    const fixture = createFixture('mcp-source-control');
    fixtures.push(fixture);
    const seeded = seedHealthy(fixture);
    const tool = toolDefs({
      db: fixture.db,
      fts5: fixture.fts5,
      home: fixture.dir,
      actor: 'mcp_host',
    }).find((candidate) => candidate.name === 'linkedin_source_manage')!;

    await expect(
      tool.handler({
        action: 'enable',
        source_id: seeded.pendingSourceId,
        command: 'ENABLE something-else',
        confirm: true,
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await tool.handler({
      action: 'enable',
      source_id: seeded.pendingSourceId,
      command: `ENABLE ${seeded.pendingSourceId}`,
      confirm: true,
    } as never);
    expect(
      fixture.db.get('SELECT status FROM sources WHERE id = ?', seeded.pendingSourceId),
    ).toMatchObject({
      status: 'enabled',
    });
  });

  it('schedules full purge only after the explicit loss acceptance', async () => {
    const fixture = createFixture('mcp-purge-control');
    fixtures.push(fixture);
    let scheduled = 0;
    const tool = toolDefs({
      db: fixture.db,
      fts5: fixture.fts5,
      home: fixture.dir,
      actor: 'mcp_host',
      scheduleFullPurge: () => {
        scheduled += 1;
      },
    }).find((candidate) => candidate.name === 'linkedin_purge_run')!;

    await expect(
      tool.handler({
        mode: 'purge_all',
        confirm_phrase: 'DELETE ALL LOCAL DATA',
        accept_no_backup: false,
        confirm: true,
      } as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const result = await tool.handler({
      mode: 'purge_all',
      confirm_phrase: 'DELETE ALL LOCAL DATA',
      accept_no_backup: true,
      confirm: true,
    } as never);
    expect(result).toEqual({ mode: 'purge_all', status: 'purging' });
    expect(scheduled).toBe(1);
  });
});
