import { describe, expect, it } from 'vitest';
import { resolveDataHome } from '@linkedin-mcp/shared';

describe('shared application data home', () => {
  it('uses and normalizes one explicit absolute home', () => {
    expect(
      resolveDataHome({
        LINKEDIN_MCP_HOME: 'C:\\Users\\member\\AppData\\Local\\linkedin-mcp\\',
      }),
    ).toBe('C:\\Users\\member\\AppData\\Local\\linkedin-mcp');
  });

  it('derives the default from LOCALAPPDATA', () => {
    expect(resolveDataHome({ LOCALAPPDATA: 'C:\\Users\\member\\AppData\\Local' })).toBe(
      'C:\\Users\\member\\AppData\\Local\\linkedin-mcp',
    );
  });

  it('refuses a relative override that would split state by working directory', () => {
    expect(() => resolveDataHome({ LINKEDIN_MCP_HOME: '.\\linkedin-mcp' })).toThrow(
      /must be an absolute path/,
    );
  });

  it('refuses a volume root as an application home', () => {
    expect(() => resolveDataHome({ LINKEDIN_MCP_HOME: 'C:\\' })).toThrow(
      /cannot be a filesystem root/,
    );
  });

  it('fails clearly when neither location is available', () => {
    expect(() => resolveDataHome({})).toThrow(/Neither LINKEDIN_MCP_HOME nor LOCALAPPDATA/);
  });
});
