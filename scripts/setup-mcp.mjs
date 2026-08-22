import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `npm run setup:mcp`, on whichever platform it is run.
//
// The assistant itself is PowerShell and configures Windows client paths, so it
// only means anything on Windows. Before this file, running the npm script on
// Linux produced ENOENT for `powershell` — a failure that says nothing about
// what is wrong or what to do instead. The work is small there anyway: one JSON
// block per client, documented per client in the server README.

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/** Exported for tests: what the dispatcher would do, without doing it. */
export function planSetup(platform = process.platform) {
  if (platform === 'win32') {
    return {
      action: 'run-powershell',
      script: join(repositoryRoot, 'setup-mcp.ps1'),
    };
  }
  return { action: 'explain', platform };
}

export const MANUAL_SETUP_NOTE = [
  'The interactive setup assistant is Windows-only: it is PowerShell, and it writes',
  'Windows client configuration paths.',
  '',
  'On this platform, configure your MCP client directly. Every client has a worked',
  'example in linkedin-mcp-server/README.md; the generic form is three fields:',
  '',
  '  {',
  '    "command": "/usr/bin/node",',
  '    "args": ["<repo>/linkedin-mcp-server/dist/index.js"],',
  '    "env": { "LINKEDIN_MCP_HOME": "$HOME/.local/share/linkedin-mcp" }',
  '  }',
  '',
  'Build the server first with `npm run build`. LINKEDIN_MCP_HOME is optional —',
  'without it the default is $XDG_DATA_HOME/linkedin-mcp, or',
  '~/.local/share/linkedin-mcp when XDG_DATA_HOME is unset — but setting the same',
  'absolute value everywhere is what makes every client and the dashboard share one',
  'database, artifact store and credential vault.',
].join('\n');

function main() {
  const plan = planSetup();
  if (plan.action === 'explain') {
    console.error(MANUAL_SETUP_NOTE);
    // Non-zero: the script was asked to configure something and did not.
    process.exitCode = 1;
    return;
  }

  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', plan.script, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
}

// Only when run directly, so the test can import planSetup without configuring
// anything on the machine running the suite. pathToFileURL rather than a
// string comparison: on Windows the two differ by drive-letter case and slash
// direction, and getting that wrong would either run the assistant during the
// test suite or never run it at all.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
