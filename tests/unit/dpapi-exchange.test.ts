import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate, openDatabase, type SqliteDriver } from '@linkedin-mcp/db';

// The exchange with powershell.exe, with the child under our control.
//
// The vault's happy path is proved against real DPAPI next door, which is the
// only way to prove it. What real DPAPI cannot show is what happens when the
// exchange goes wrong: a PowerShell that never answers, one that answers with
// something that is not base64, one that cannot be started for a reason other
// than being absent, and a second process that writes the master key while we
// are still inside our own 200ms spawn. Each has a different remedy, and a
// member handed the wrong one goes and does the wrong thing — deleting a
// secrets folder that was fine, or re-pasting a token that was never the
// problem.
//
// So the child is a fake here, driven by `behaviour`. Its default is an
// identity transform: whatever goes in comes back, which is a working vault
// with the operating system's part removed.

type Behaviour =
  | { kind: 'identity' }
  | { kind: 'hang' }
  | { kind: 'no-pipes' }
  | { kind: 'spawn-error'; code: string }
  | { kind: 'exit'; code: number | null; out: string }
  | { kind: 'race'; write: () => void };

let behaviour: Behaviour = { kind: 'identity' };
const ops: string[] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (_exe: string, args: readonly string[]) => fakePowerShell(args),
  };
});

function fakePowerShell(args: readonly string[]): unknown {
  // The op rides in argv as a UTF-16LE base64 script, which is also how the
  // real child learns which way round the exchange goes.
  const encoded = args[args.indexOf('-EncodedCommand') + 1] ?? '';
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  const op = script.includes('::Unprotect(') ? 'Unprotect' : 'Protect';
  ops.push(op);

  const child = new EventEmitter() as EventEmitter & {
    stdin: Writable | null;
    stdout: EventEmitter | null;
    stderr: (EventEmitter & { resume: () => void }) | null;
    kill: () => void;
  };
  const stdout = new EventEmitter();
  const stderr = Object.assign(new EventEmitter(), { resume: () => {} });

  if (behaviour.kind === 'no-pipes') {
    child.stdin = null;
    child.stdout = null;
    child.stderr = null;
    child.kill = () => {};
    return child;
  }

  const received: Buffer[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      received.push(Buffer.from(chunk as Uint8Array));
      cb();
    },
  });

  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  // The real child dies on kill and the close carries a null code; that is what
  // the timeout path is waiting for.
  child.kill = () => child.emit('close', null);

  stdin.on('finish', () => {
    if (behaviour.kind === 'hang') return;
    queueMicrotask(() => {
      const input = Buffer.concat(received).toString('ascii').trim();
      if (behaviour.kind === 'spawn-error') {
        child.emit('error', Object.assign(new Error('spawn failed'), { code: behaviour.code }));
        return;
      }
      if (behaviour.kind === 'exit') {
        if (behaviour.out) stdout.emit('data', Buffer.from(behaviour.out, 'ascii'));
        child.emit('close', behaviour.code);
        return;
      }
      if (behaviour.kind === 'race' && op === 'Protect') behaviour.write();
      // Identity: DPAPI's wrapping is the part we are not testing here.
      stdout.emit('data', Buffer.from(input, 'ascii'));
      child.emit('close', 0);
    });
  });

  return child;
}

const { createSecretStore } = await import('../../packages/domain/src/secretStore.ts');

const TOKEN = 'AQV-fake-fixture-token-not-a-real-credential-0123456789';
const NAME = 'linkedin.access_token.read';

let home: string;
let db: SqliteDriver;

const keyPath = () => join(home, 'secrets', 'master.key.dpapi');

beforeEach(() => {
  behaviour = { kind: 'identity' };
  ops.length = 0;
  home = mkdtempSync(join(tmpdir(), 'linkedin-mcp-dpapi-'));
  const opened = openDatabase(join(home, 'data', 'linkedin.sqlite3'));
  db = opened.db;
  migrate(db);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  db.close();
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* the OS reclaims it */
  }
});

describe('the exchange when it works', () => {
  it('wraps once and reuses the key for the rest of the process', async () => {
    const store = createSecretStore(db, home);

    await store.put(NAME, TOKEN);
    await store.put('linkedin.client_id.read', 'cid-read');
    expect(await store.get(NAME)).toBe(TOKEN);

    // One spawn, not one per operation: the interpreter costs ~200ms and the
    // dashboard pastes a client id and a token together.
    expect(ops).toEqual(['Protect']);
  });

  it('unwraps the key from disk in a second store over the same home', async () => {
    await createSecretStore(db, home).put(NAME, TOKEN);
    ops.length = 0;

    expect(await createSecretStore(db, home).get(NAME)).toBe(TOKEN);
    expect(ops).toEqual(['Unprotect']);
  });

  it('falls back to a bare interpreter name when SystemRoot is unset', async () => {
    vi.stubEnv('SystemRoot', '');
    const store = createSecretStore(db, home);

    // The absolute path exists so a powershell.exe planted earlier on PATH
    // cannot be handed the master key. With no SystemRoot there is no absolute
    // path to build, and refusing outright would strand a host that is merely
    // unusual rather than hostile.
    await store.put(NAME, TOKEN);
    expect(await store.get(NAME)).toBe(TOKEN);
  });

  it('trims a pasted value, because a trailing newline reads as a dead token', async () => {
    const store = createSecretStore(db, home);

    await store.put(NAME, `  ${TOKEN}\r\n`);

    // The newline would become an invalid Authorization header hours later and
    // look exactly like a revoked credential.
    expect(await store.get(NAME)).toBe(TOKEN);
  });
});

describe('when powershell cannot be started', () => {
  it('names the missing interpreter and says the rest of the product works', async () => {
    behaviour = { kind: 'spawn-error', code: 'ENOENT' };

    await expect(createSecretStore(db, home).put(NAME, TOKEN)).rejects.toThrow(
      /rest of the product works/i,
    );
  });

  it('reports a start failure that is not an absent interpreter differently', async () => {
    behaviour = { kind: 'spawn-error', code: 'EACCES' };

    // "Not found" would send the member looking for a file that is right there;
    // this is a blocked or broken start, and the remedy is different.
    const failure = await createSecretStore(db, home)
      .put(NAME, TOKEN)
      .catch((e: unknown) => e);

    expect(String(failure)).toMatch(/could not be started/i);
    expect(String(failure)).not.toMatch(/was not found/i);
  });

  it('refuses to run the exchange over a child with no pipes', async () => {
    behaviour = { kind: 'no-pipes' };

    // Key material goes over stdin precisely because argv is readable by every
    // process on the machine. With no stdin there is no safe way to hand it
    // over, so the exchange does not happen at all.
    await expect(createSecretStore(db, home).put(NAME, TOKEN)).rejects.toThrow(/pipes/i);
  });
});

describe('when powershell answers badly', () => {
  it('kills a child that never answers and says to retry', async () => {
    vi.useFakeTimers();
    behaviour = { kind: 'hang' };

    const attempt = createSecretStore(db, home).put(NAME, TOKEN);
    const settled = attempt.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);

    const failure = await settled;
    // Retryable, and it names the likely cause: an endpoint agent holding
    // powershell.exe is the common one, and it is not a corrupt vault.
    expect(String(failure)).toMatch(/did not finish within/i);
    expect(String(failure)).toMatch(/endpoint agent/i);
  });

  it('reports a failed wrap as nothing stored, not as a corrupt vault', async () => {
    behaviour = { kind: 'exit', code: 1, out: '' };

    const failure = await createSecretStore(db, home)
      .put(NAME, TOKEN)
      .catch((e: unknown) => e);

    expect(String(failure)).toMatch(/refused to wrap/i);
    // The distinction matters: nothing was written, so there is nothing to
    // delete and no reason to re-mint a token.
    expect(String(failure)).toMatch(/no secret was stored/i);
  });

  it('treats an answer that is not base64 as a failed call', async () => {
    behaviour = { kind: 'exit', code: 0, out: 'Add-Type : Cannot load assembly' };

    // Exit zero is not enough. A .NET warning on stdout would otherwise be
    // decoded as key material.
    await expect(createSecretStore(db, home).put(NAME, TOKEN)).rejects.toThrow(/refused to wrap/i);
  });

  it('tells a member whose secrets folder came from elsewhere to delete it', async () => {
    mkdirSync(join(home, 'secrets'), { recursive: true });
    writeFileSync(keyPath(), Buffer.from('from another machine').toString('base64'), 'utf8');
    behaviour = { kind: 'exit', code: 1, out: '' };

    const failure = await createSecretStore(db, home)
      .get(NAME)
      .catch((e: unknown) => e);

    // Nothing is stored under this name, so the read is answered without DPAPI.
    expect(failure).toBeNull();

    await createSecretStore(db, home)
      .put(NAME, TOKEN)
      .catch(() => {});
    const onRead = await createSecretStore(db, home)
      .put('linkedin.client_id.read', 'cid')
      .catch((e: unknown) => e);

    // Bound to this Windows user and this machine, so a copied folder can never
    // be unwrapped here — the remedy is deletion, not retrying.
    expect(String(onRead)).toMatch(/never be unwrapped|refused to unwrap/i);
  });

  it('calls a key file that unwraps to the wrong shape corrupt', async () => {
    mkdirSync(join(home, 'secrets'), { recursive: true });
    // Identity-wrapped, so it unwraps cleanly and is still not an envelope.
    writeFileSync(keyPath(), Buffer.alloc(12, 7).toString('base64'), 'utf8');

    await expect(createSecretStore(db, home).get(NAME)).resolves.toBeNull();
    await expect(createSecretStore(db, home).put(NAME, TOKEN)).rejects.toThrow(
      /master key envelope/i,
    );
  });
});

describe('two processes opening one home at the same time', () => {
  it('adopts the key the other process wrote rather than clobbering it', async () => {
    // A valid identity-wrapped envelope, written by "the other process" while
    // we are still inside our own spawn.
    const winner = Buffer.concat([Buffer.of(1), Buffer.alloc(8, 9), Buffer.alloc(32, 3)]);
    behaviour = {
      kind: 'race',
      write: () => {
        mkdirSync(join(home, 'secrets'), { recursive: true });
        writeFileSync(keyPath(), winner.toString('base64'), 'utf8');
      },
    };

    const store = createSecretStore(db, home);
    await store.put(NAME, TOKEN);

    // Clobbering would strand every row the winner had already encrypted, so
    // the loser adopts the winner's key and encrypts under it.
    expect(readFileSync(keyPath(), 'utf8').trim()).toBe(winner.toString('base64'));
    expect(String(db.get('SELECT key_id FROM secrets WHERE name = ?', NAME)?.['key_id'])).toBe(
      `mk_${winner.subarray(1, 9).toString('hex')}`,
    );
    expect(await store.get(NAME)).toBe(TOKEN);
  });
});

describe('a secrets row written by something other than this store', () => {
  // STRICT is what normally makes this impossible: SQLite refuses TEXT in a
  // BLOB column. A database restored from somewhere else carries its own
  // schema, though, and that is the case the guard is for — so the table is
  // rebuilt here without STRICT, which is exactly what "written by something
  // other than this store" means.
  async function foreignRow(column: string): Promise<void> {
    const store = createSecretStore(db, home);
    await store.put(NAME, TOKEN);
    const keyId = String(db.get('SELECT key_id FROM secrets WHERE name = ?', NAME)?.['key_id']);

    db.run('DROP TABLE secrets');
    db.run(
      `CREATE TABLE secrets (
         name TEXT PRIMARY KEY, ciphertext BLOB NOT NULL, iv BLOB NOT NULL,
         auth_tag BLOB NOT NULL, key_id TEXT NOT NULL, created_at TEXT NOT NULL,
         rotated_at TEXT
       )`,
    );
    const values: Record<string, unknown> = {
      ciphertext: Buffer.alloc(16),
      iv: Buffer.alloc(12),
      auth_tag: Buffer.alloc(16),
    };
    values[column] = 'text where bytes belong';
    db.run(
      'INSERT INTO secrets (name, ciphertext, iv, auth_tag, key_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      NAME,
      values['ciphertext'] as never,
      values['iv'] as never,
      values['auth_tag'] as never,
      keyId,
      new Date().toISOString(),
    );
  }

  it('refuses a row whose iv column is not binary', async () => {
    await foreignRow('iv');

    await expect(createSecretStore(db, home).get(NAME)).rejects.toThrow(/non-binary iv/i);
  });

  it('refuses a row whose auth tag column is not binary', async () => {
    await foreignRow('auth_tag');

    await expect(createSecretStore(db, home).get(NAME)).rejects.toThrow(/non-binary auth_tag/i);
  });

  it('refuses a row whose ciphertext column is not binary', async () => {
    await foreignRow('ciphertext');

    // Every one of these says the row came from somewhere else, because that is
    // the actionable fact: this store never writes a text column here.
    await expect(createSecretStore(db, home).get(NAME)).rejects.toThrow(/non-binary ciphertext/i);
  });
});

describe('a transient failure', () => {
  it('does not poison the store for the life of the process', async () => {
    const store = createSecretStore(db, home);
    behaviour = { kind: 'exit', code: 1, out: '' };
    await expect(store.put(NAME, TOKEN)).rejects.toThrow();

    behaviour = { kind: 'identity' };

    // The in-flight promise is cleared on failure, so one bad spawn does not
    // leave every later call awaiting a rejection that already happened.
    await store.put(NAME, TOKEN);
    expect(await store.get(NAME)).toBe(TOKEN);
  });
});
