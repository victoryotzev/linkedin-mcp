import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manualSetupNote, planSetup } from '../../scripts/setup-mcp.mjs';
import { IS_WINDOWS } from '../helpers/platform.ts';

const scriptPath = fileURLToPath(new URL('../../scripts/setup-mcp.mjs', import.meta.url));

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
  const MANUAL_SETUP_NOTE = manualSetupNote('linux');

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

  it('names the macOS home on macOS, and never the Linux one', () => {
    // Printing ~/.local/share to a Mac user sends them to a directory macOS
    // does not use for application data — worse than printing nothing.
    const mac = manualSetupNote('darwin');
    expect(mac).toContain('Library/Application Support/linkedin-mcp');
    expect(mac).not.toContain('.local/share');
  });

  it('points at the per-client examples for anyone who wants one', () => {
    expect(MANUAL_SETUP_NOTE).toContain('linkedin-mcp-server/README.md');
  });
});

// Running the dispatcher for real, off Windows.
//
// planSetup and manualSetupNote are pure and covered above, but main() — the
// direct-run guard, the console.error, the exit code — was asserted only by
// hand. The docs promise `npm run setup:mcp` prints the manual block instead of
// failing with ENOENT here, so a test spawns the actual script and checks it.
// Gated off Windows, where main() would instead shell out to PowerShell.
describe.skipIf(IS_WINDOWS)('running scripts/setup-mcp.mjs directly', () => {
  it('exits non-zero and prints the manual configuration block', () => {
    const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });

    // Non-zero: it was asked to configure something and, correctly, did not.
    expect(result.status).toBe(1);
    // The whole of manual setup is on stderr, not a bare ENOENT.
    expect(result.stderr).toContain('Windows-only');
    expect(result.stderr).toContain('"command"');
    expect(result.stderr).toContain('LINKEDIN_MCP_HOME');
    expect(result.stderr).toContain('linkedin-mcp-server/dist/index.js');
    expect(result.stdout).not.toMatch(/powershell/i);
  });
});
