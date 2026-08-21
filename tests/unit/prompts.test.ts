import { describe, expect, it } from 'vitest';
import { PROMPT_DEFS } from '../../linkedin-mcp-server/src/prompts.ts';

describe('MCP workflow prompts', () => {
  it('publishes five unique workflows including MCP-first evidence ingestion', () => {
    expect(PROMPT_DEFS).toHaveLength(5);
    expect(new Set(PROMPT_DEFS.map((prompt) => prompt.name)).size).toBe(5);
    expect(PROMPT_DEFS.map((prompt) => prompt.name)).toContain('ingest_and_review_evidence');
  });

  it('keeps source enablement and claim decisions at the human boundary', () => {
    const prompt = PROMPT_DEFS.find((candidate) => candidate.name === 'ingest_and_review_evidence');
    const text = prompt?.build({
      path: 'C:\\evidence\\cv.pdf',
      kind: 'document',
      trust: 'personal_doc',
      label: 'Current CV',
    });
    expect(text).toContain('linkedin_source_manage');
    expect(text).toContain('ask the user for `ENABLE <source_id>`');
    expect(text).toContain('Only after they explicitly confirm');
    expect(text).toContain('explicitly confirms it');
    expect(text).toContain('dashboard All MCP tools view');
  });
});
