import { describe, expect, it } from 'vitest';
import { MANUAL_SETUP_NOTE, planSetup } from '../../scripts/setup-mcp.mjs';

// What `npm run setup:mcp` does on a platform its assistant was never written
// for.
//
// The assistant is PowerShell and writes Windows client configuration paths, so
// it only means anything on Windows. What matters here is that the other
// platforms get an explanation rather than `ENOENT: powershell` — a failure
// that says nothing about what is wrong or what to do instead.
//
// `planSetup` returns the decision without acting on it, so the suite can check
// the Windows branch without configuring anything on the machine running it.

describe('deciding what setup:mcp should do', () => {
  it('runs the PowerShell assistant on Windows', () => {
    const plan = planSetup('win32');

    expect(plan.action).toBe('run-powershell');
    expect(plan.script).toMatch(/setup-mcp\.ps1$/);
  });

  it('explains instead, on every platform the assistant was not written for', () => {
    for (const platform of ['linux', 'darwin', 'freebsd']) {
      expect(planSetup(platform)).toEqual({ action: 'explain', platform });
    }
  });
});

describe('what it tells someone who cannot run the assistant', () => {
  it('says why, so the reader does not go looking for a broken script', () => {
    expect(MANUAL_SETUP_NOTE).toMatch(/Windows-only/i);
  });

  it('gives the whole of manual setup rather than only pointing at a document', () => {
    // Someone blocked at this exact moment should be able to finish from what is
    // on their screen. All three fields the client needs are here.
    expect(MANUAL_SETUP_NOTE).toContain('"command"');
    expect(MANUAL_SETUP_NOTE).toContain('"args"');
    expect(MANUAL_SETUP_NOTE).toContain('LINKEDIN_MCP_HOME');
    expect(MANUAL_SETUP_NOTE).toContain('linkedin-mcp-server/dist/index.js');
  });

  it('names the build step, without which the path it just printed does not exist', () => {
    expect(MANUAL_SETUP_NOTE).toMatch(/npm run build/);
  });

  it('states the default home, and that setting it is optional', () => {
    expect(MANUAL_SETUP_NOTE).toContain('$XDG_DATA_HOME/linkedin-mcp');
    expect(MANUAL_SETUP_NOTE).toContain('~/.local/share/linkedin-mcp');
    expect(MANUAL_SETUP_NOTE).toMatch(/optional/i);
  });

  it('points at the per-client examples for anyone who wants one', () => {
    expect(MANUAL_SETUP_NOTE).toContain('linkedin-mcp-server/README.md');
  });
});
