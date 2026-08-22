import { describe, expect, it } from 'vitest';
import { resolveDataHome } from '@linkedin-mcp/shared';

// Where the data home lands when nobody has said.
//
// The platform is an argument, so the Windows default is checked on Linux and
// the Linux default on Windows. That matters more than usual here: `C:\x` is
// not absolute to POSIX and `/x` is absolute to Windows, so a test that ran
// only on its own platform would be asserting against the wrong path rules.

describe('an explicitly configured home', () => {
  it('wins on either platform', () => {
    expect(resolveDataHome({ LINKEDIN_MCP_HOME: 'D:\\evidence' }, 'win32')).toBe('D:\\evidence');
    expect(resolveDataHome({ LINKEDIN_MCP_HOME: '/srv/evidence' }, 'linux')).toBe('/srv/evidence');
  });

  it('is still required to be absolute, per platform', () => {
    expect(() => resolveDataHome({ LINKEDIN_MCP_HOME: 'evidence' }, 'win32')).toThrowError(
      /absolute path/i,
    );
    expect(() => resolveDataHome({ LINKEDIN_MCP_HOME: 'evidence' }, 'linux')).toThrowError(
      /absolute path/i,
    );
    // A Windows path is not absolute to Linux, and saying so early beats
    // creating `./C:\evidence` in the working directory.
    expect(() => resolveDataHome({ LINKEDIN_MCP_HOME: 'C:\\evidence' }, 'linux')).toThrowError(
      /absolute path/i,
    );
  });

  it('is still refused when it is a filesystem root', () => {
    expect(() => resolveDataHome({ LINKEDIN_MCP_HOME: 'C:\\' }, 'win32')).toThrowError(
      /filesystem root/i,
    );
    expect(() => resolveDataHome({ LINKEDIN_MCP_HOME: '/' }, 'linux')).toThrowError(
      /filesystem root/i,
    );
  });

  it('drops trailing separators on either platform', () => {
    expect(resolveDataHome({ LINKEDIN_MCP_HOME: 'D:\\evidence\\\\' }, 'win32')).toBe(
      'D:\\evidence',
    );
    expect(resolveDataHome({ LINKEDIN_MCP_HOME: '/srv/evidence///' }, 'linux')).toBe(
      '/srv/evidence',
    );
  });
});

describe('the Windows default', () => {
  it('lands under LOCALAPPDATA', () => {
    expect(resolveDataHome({ LOCALAPPDATA: 'C:\\Users\\alex\\AppData\\Local' }, 'win32')).toBe(
      'C:\\Users\\alex\\AppData\\Local\\linkedin-mcp',
    );
  });

  it('says which variables it looked at when none is set', () => {
    expect(() => resolveDataHome({}, 'win32')).toThrowError(/LINKEDIN_MCP_HOME nor LOCALAPPDATA/i);
  });

  it('ignores XDG, which means nothing here', () => {
    expect(() =>
      resolveDataHome({ XDG_DATA_HOME: '/home/alex/.local/share' }, 'win32'),
    ).toThrowError(/LOCALAPPDATA/i);
  });
});

describe('the Linux default', () => {
  it('honours XDG_DATA_HOME, because a member who set it has already said where data goes', () => {
    expect(resolveDataHome({ XDG_DATA_HOME: '/home/alex/.local/share' }, 'linux')).toBe(
      '/home/alex/.local/share/linkedin-mcp',
    );
  });

  it('falls back to the location the XDG specification names when it is unset', () => {
    expect(resolveDataHome({ HOME: '/home/alex' }, 'linux')).toBe(
      '/home/alex/.local/share/linkedin-mcp',
    );
  });

  it('prefers XDG_DATA_HOME over HOME when both are set', () => {
    expect(resolveDataHome({ XDG_DATA_HOME: '/mnt/data', HOME: '/home/alex' }, 'linux')).toBe(
      '/mnt/data/linkedin-mcp',
    );
  });

  it('says which variables it looked at when none is set', () => {
    expect(() => resolveDataHome({}, 'linux')).toThrowError(
      /LINKEDIN_MCP_HOME, XDG_DATA_HOME or HOME/i,
    );
  });

  it('ignores LOCALAPPDATA, which a Wine-ish environment might still export', () => {
    expect(() =>
      resolveDataHome({ LOCALAPPDATA: 'C:\\Users\\alex\\AppData\\Local' }, 'linux'),
    ).toThrowError(/XDG_DATA_HOME or HOME/i);
  });

  it('refuses a relative XDG_DATA_HOME rather than resolving it against the cwd', () => {
    // Two MCP hosts with different working directories would otherwise open two
    // different databases while both looked correctly configured.
    expect(() => resolveDataHome({ XDG_DATA_HOME: '.local/share' }, 'linux')).toThrowError(
      /absolute path/i,
    );
  });

  it('applies to any non-Windows platform, not only to linux', () => {
    expect(resolveDataHome({ HOME: '/Users/alex' }, 'darwin')).toBe(
      '/Users/alex/.local/share/linkedin-mcp',
    );
  });
});
