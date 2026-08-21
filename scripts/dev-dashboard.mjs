// Dev runner for the dashboard: builds the browser client, then watches both
// halves at once.
//
// Two processes rather than one because they have different jobs and different
// restart costs. tsx restarts the server whenever a server file changes, which
// drops every in-memory session; keeping the client out of its watch set means
// editing a component no longer logs you out.
//
// The one-shot build runs first and must succeed: the server refuses to start
// without built assets, so racing it against a watcher's first pass would just
// produce a confusing exit.
//
// Spawned by name, not by path — npm puts node_modules/.bin on PATH, and the
// repo lives under a directory with a space in it, which a quoted shell command
// would have to work around.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../linkedin-dashboard/', import.meta.url));
const shell = process.platform === 'win32';
const children = [];

function run(command, args) {
  const child = spawn(command, args, { cwd, stdio: 'inherit', shell });
  children.push(child);
  return child;
}

function shutdown(code) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}

const CLIENT_ARGS = ['--config', 'tsup.client.config.ts'];

run('tsup', CLIENT_ARGS).on('exit', (code) => {
  if (code !== 0) {
    console.error('[dev-dashboard] client build failed; not starting the server');
    shutdown(code ?? 1);
    return;
  }
  // --no-clean is load-bearing: the config sets clean:true, and a watcher that
  // wipes dist/client on startup would delete the assets the server is about to
  // read. The one-shot build above already cleaned.
  run('tsup', [...CLIENT_ARGS, '--watch', '--no-clean']);
  run('tsx', ['watch', 'src/server.ts']).on('exit', (serverCode) => shutdown(serverCode ?? 0));
});
