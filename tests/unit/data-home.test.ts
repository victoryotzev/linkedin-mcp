import { describe, expect, it } from 'vitest';
import { resolveDataHome } from '@linkedin-mcp/shared';

// The Windows side of data-home resolution, stated as such.
//
// Every case here is about Windows paths and the LOCALAPPDATA default, so the
// platform is passed explicitly rather than inherited from whoever is running
// the suite. tests/unit/data-home-platforms.test.ts covers both defaults, from
// either host.
describe('shared application data home, on Windows', () => {
  it('uses and normalizes one explicit absolute home', () => {
    expect(
      resolveDataHome(
        {
          LINKEDIN_MCP_HOME: 'C:\\Users\\member\\AppData\\Local\\linkedin-mcp\\',
        },
        'win32',
      ),
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
    expect(() => resolveDataHome({}, 'win32')).toThrow(
      /Neither LINKEDIN_MCP_HOME nor LOCALAPPDATA/,
    );
  });
});
