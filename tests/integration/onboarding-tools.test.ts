import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { listSources } from '@linkedin-mcp/domain';
import { toolDefs } from '../../linkedin-mcp-server/src/catalog.ts';
import { featureForTool } from '../../linkedin-mcp-server/src/featureRouting.ts';
import { createFixture, type Fixture } from '../helpers/fixtures.ts';

// Self-description is the one evidence path whose payload arrives through the
// model channel. Everything here is about that: the member approves a specific
// piece of text, and the tool must be unable to store a different one.

const fixtures: Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function tools(label: string) {
  const fixture = createFixture(label);
  fixtures.push(fixture);
  const defs = toolDefs({
    db: fixture.db,
    fts5: fixture.fts5,
    home: fixture.dir,
    actor: 'mcp_host',
  });
  return {
    fixture,
    describeTool: defs.find((d) => d.name === 'linkedin_intake_describe')!,
    readinessTool: defs.find((d) => d.name === 'linkedin_readiness_check')!,
  };
}

const TEXT =
  'I build local-first developer tools, mostly in TypeScript, and I care about making evidence auditable.';
const commandFor = (text: string) =>
  `DESCRIBE ${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8)}`;

describe('linkedin_readiness_check', () => {
  it('is read-only and never gated behind a feature switch', async () => {
    const { readinessTool, fixture } = tools('readiness-tool');

    // The tool that explains why nothing works must stay reachable when
    // features are switched off.
    expect(featureForTool('linkedin_readiness_check')).toBeNull();
    expect(readinessTool.annotations.readOnlyHint).toBe(true);

    const result = (await readinessTool.handler({} as never)) as { is_first_run: boolean };
    expect(result.is_first_run).toBe(true);
    expect(listSources(fixture.db)).toHaveLength(0);
  });
});

describe('linkedin_intake_describe', () => {
  it('previews without storing anything when unconfirmed', async () => {
    const { describeTool, fixture } = tools('describe-preview');

    const result = (await describeTool.handler({
      text: TEXT,
      label: 'About me',
      confirm: false,
    } as never)) as { stored: boolean; expected_command: string; source_id: string | null };

    expect(result.stored).toBe(false);
    expect(result.source_id).toBeNull();
    expect(result.expected_command).toBe(commandFor(TEXT));
    expect(listSources(fixture.db)).toHaveLength(0);
  });

  it('refuses a command bound to different text', async () => {
    const { describeTool, fixture } = tools('describe-mismatch');

    // The attack this exists to stop: collect the member's yes for one text,
    // then store another.
    await expect(
      describeTool.handler({
        text: 'Actually something the member never saw, at least forty characters long.',
        label: 'About me',
        confirm: true,
        command: commandFor(TEXT),
      } as never),
    ).rejects.toMatchObject({ blockers: ['confirmation_required'] });

    expect(listSources(fixture.db)).toHaveLength(0);
  });

  it('refuses a missing or malformed command', async () => {
    const { describeTool } = tools('describe-nocommand');

    for (const command of [undefined, 'DESCRIBE', 'yes', 'ENABLE src_1']) {
      await expect(
        describeTool.handler({ text: TEXT, label: 'About me', confirm: true, command } as never),
      ).rejects.toMatchObject({ blockers: ['confirmation_required'] });
    }
  });

  it('stores the text as self-attested evidence when the command matches', async () => {
    const { describeTool, fixture } = tools('describe-store');

    const result = (await describeTool.handler({
      text: TEXT,
      label: 'About me',
      confirm: true,
      command: commandFor(TEXT),
    } as never)) as { stored: boolean; source_id: string; artifact_id: string; trust: string };

    expect(result.stored).toBe(true);
    expect(result.trust).toBe('self_attested');
    expect(result.artifact_id).toBeTruthy();

    const sources = listSources(fixture.db);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.trust).toBe('self_attested');
    expect(sources[0]!.status).toBe('enabled');
    expect(sources[0]!.root_path).toBe(`manual://${sources[0]!.id}`);

    const text = String(
      fixture.db.get(
        `SELECT e.text FROM extractions e
         JOIN artifacts a ON a.id = e.artifact_id
         WHERE a.source_id = ?`,
        result.source_id,
      )?.['text'] ?? '',
    );
    expect(text).toContain('local-first developer tools');
  });

  it('records enabling as a human decision in the audit log', async () => {
    const { describeTool, fixture } = tools('describe-audit');

    await describeTool.handler({
      text: TEXT,
      label: 'About me',
      confirm: true,
      command: commandFor(TEXT),
    } as never);

    const event = fixture.db.get(
      "SELECT actor, event_type FROM audit_events WHERE event_type = 'source.enabled'",
    );
    expect(event).toBeDefined();
    expect(event!['actor']).toBe('mcp_host');
  });

  it('still redacts a secret the member pastes into their own description', async () => {
    const { describeTool, fixture } = tools('describe-redact');
    const leaky = `I run our AWS estate. My key is AKIAIOSFODNN7EXAMPLE, which I should not have pasted.`;

    const result = (await describeTool.handler({
      text: leaky,
      label: 'About me',
      confirm: true,
      command: commandFor(leaky),
    } as never)) as { source_id: string };

    const text = String(
      fixture.db.get(
        `SELECT e.text FROM extractions e
         JOIN artifacts a ON a.id = e.artifact_id
         WHERE a.source_id = ?`,
        result.source_id,
      )?.['text'] ?? '',
    );
    expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(text).toContain('[REDACTED:aws_access_key:');
  });

  it('rejects text too short to be a description', async () => {
    const { describeTool } = tools('describe-short');
    const schema = describeTool.inputSchema;

    expect(schema.safeParse({ text: 'too short', confirm: false }).success).toBe(false);
  });
});
