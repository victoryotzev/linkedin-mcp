import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { withWriteTx, type Row, type SqliteDriver } from '@linkedin-mcp/db';
import { DomainError } from '@linkedin-mcp/shared';
import { readOrCreateKeychainKey, type KeychainRunner } from './keychain.ts';
import {
  deriveKeyEncryptionKey,
  readMachineId,
  unwrapWithMachineKey,
  wrapWithMachineKey,
  type MachineIdentity,
} from './machineKey.ts';
import { openKey, sealKey } from './sealedKey.ts';

// Three trust anchors, one per platform, and it is worth being exact about
// what each buys.
//
//   Windows  DPAPI (CurrentUser) wraps the master key with material derived
//            from this Windows account.
//   macOS    the login Keychain holds a random key-encryption key behind an
//            access-control list (keychain.ts).
//   Linux    the key-encryption key is derived from the machine id and uid and
//            never stored (machineKey.ts).
//
// All three make the file on disk inert on another machine, under another
// account, and to anyone who images the drive. None of them protects the key
// from *this* user: on Windows any process running as you can call Unprotect,
// on macOS `security` will hand the item to a process on its ACL, and on Linux
// the machine id is world-readable so the key can simply be re-derived. There
// is no passphrase and no hardware binding anywhere. They raise the cost of
// offline and cross-account theft; none is a defence against malware running
// as you.
//
// They are not equal, and SECURITY.md ranks them rather than implying parity:
// macOS is strongest because its key is random and OS-held, Linux weakest
// because its key is derivable from a public file.
//
// A passphrase was considered and rejected for all three: the dashboard is a
// background local service and an MCP client starts the server with no
// terminal, so the passphrase would end up cached in the same process — this
// security model with extra steps and a worse failure mode.

export interface SecretStore {
  put(name: string, value: string): Promise<void>;
  get(name: string): Promise<string | null>;
  has(name: string): boolean;
  remove(name: string): Promise<void>;
  listNames(): string[];
}

// LinkedIn forces the read and write lanes into separate developer apps
// (binding an app to the Data Portability company page permanently blocks the
// share products), so one member holds two client ids and two tokens.
export const SECRET_NAMES = {
  ACCESS_TOKEN_READ: 'linkedin.access_token.read',
  ACCESS_TOKEN_WRITE: 'linkedin.access_token.write',
  CLIENT_ID_READ: 'linkedin.client_id.read',
  CLIENT_ID_WRITE: 'linkedin.client_id.write',
} as const;

// Writes are allowlisted the same way settings are: this table is a credential
// vault, not a general key-value store that other code can grow into.
const STORABLE_NAMES: readonly string[] = Object.values(SECRET_NAMES);

// One file name per wrapping scheme, deliberately. A secrets folder carried
// between platforms then fails by not being found — the vault starts fresh and
// says so — rather than by handing DPAPI a blob it will reject with a message
// about corruption. The Windows name is unchanged, so existing installs keep
// their key.
const MASTER_KEY_FILE_DPAPI = 'master.key.dpapi';
const MASTER_KEY_FILE_MACHINE = 'master.key.mkey';
const MASTER_KEY_FILE_KEYCHAIN = 'master.key.keychain';

// The unwrapped envelope is [version:1][key_id:8][aes-256 key:32]. The key id
// is random and travels *inside* the wrapped blob rather than being derived
// from the key, so the plaintext key_id column reveals nothing about the key.
const ENVELOPE_VERSION = 1;
const KEY_ID_BYTES = 8;
const AES_KEY_BYTES = 32;
const ENVELOPE_BYTES = 1 + KEY_ID_BYTES + AES_KEY_BYTES;
const IV_BYTES = 12;

interface MasterKey {
  keyId: string;
  key: Buffer;
}

type DpapiOp = 'Protect' | 'Unprotect';

const DPAPI_TIMEOUT_MS = 15_000;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// Absolute path: a `powershell.exe` planted earlier on PATH would otherwise be
// handed the master key in plaintext on stdin.
function powershellPath(): string {
  const systemRoot = process.env['SystemRoot'];
  return systemRoot
    ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

// Windows PowerShell 5.1 specifically: ProtectedData lives in the .NET
// Framework System.Security assembly, which Add-Type loads on demand. pwsh 7
// would need a NuGet package we are not going to ship.
function dpapiScript(op: DpapiOp): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
    `$out = [System.Security.Cryptography.ProtectedData]::${op}($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)`,
    '[Console]::Out.Write([Convert]::ToBase64String($out))',
  ].join('\n');
}

async function dpapi(op: DpapiOp, inputBase64: string, keyPath: string): Promise<Buffer> {
  // -EncodedCommand (UTF-16LE base64) instead of -Command: it removes the
  // quoting minefield between Node's Windows argv escaping and PowerShell's
  // parser. Only the *script* rides in argv — key material goes over stdin,
  // because argv is readable by every process on the machine.
  const encoded = Buffer.from(dpapiScript(op), 'utf16le').toString('base64');
  const child = spawn(
    powershellPath(),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true },
  );
  const { stdin, stdout, stderr } = child;
  if (stdin === null || stdout === null || stderr === null) {
    child.kill();
    throw new DomainError(
      'INTERNAL',
      'powershell.exe started without stdio pipes, so the DPAPI exchange cannot run',
      { blockers: ['dpapi_no_pipes'] },
    );
  }

  let timedOut = false;
  const result = await new Promise<{ code: number | null; out: string }>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, DPAPI_TIMEOUT_MS);
    stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    // Drained and discarded. Draining is mandatory (a full stderr pipe stalls
    // the child); discarding is deliberate, because a .NET exception message
    // is the one channel that could echo our own input back into an error
    // string we later surface. The exit code is the diagnostic.
    stderr.resume();
    stdin.on('error', () => {
      // Child died before reading stdin; 'close' carries the real cause.
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out: Buffer.concat(chunks).toString('ascii') });
    });
    stdin.end(inputBase64);
  }).catch((err: unknown) => {
    const spawnCode = (err as NodeJS.ErrnoException).code;
    throw new DomainError(
      'INTERNAL',
      spawnCode === 'ENOENT'
        ? `Windows PowerShell was not found at ${powershellPath()}. DPAPI is how this build protects credentials, so secret storage is unavailable on this host; the rest of the product works without it.`
        : `powershell.exe could not be started for the DPAPI ${op} call`,
      { blockers: ['powershell_unavailable'] },
    );
  });

  if (timedOut) {
    throw new DomainError(
      'INTERNAL',
      `the DPAPI ${op} call did not finish within ${DPAPI_TIMEOUT_MS}ms and was killed; retry, and if it persists check whether an endpoint agent is blocking powershell.exe`,
      { blockers: ['dpapi_timeout'], retryable: true },
    );
  }

  const out = result.out.trim();
  if (result.code !== 0 || !BASE64_RE.test(out)) {
    if (op === 'Unprotect') {
      throw new DomainError(
        'INTEGRITY_ERROR',
        `Windows DPAPI refused to unwrap ${keyPath} (powershell exit ${result.code}). DPAPI material is bound to this Windows user and this machine, so a secrets folder copied from another PC, restored from a backup, or written under a different account can never be unwrapped here. Delete that folder and re-paste your LinkedIn token in the dashboard (Capabilities area).`,
        { blockers: ['dpapi_unwrap_failed'] },
      );
    }
    throw new DomainError(
      'INTERNAL',
      `Windows DPAPI refused to wrap the master key (powershell exit ${result.code}); no secret was stored`,
      { blockers: ['dpapi_protect_failed'] },
    );
  }
  return Buffer.from(out, 'base64');
}

function parseEnvelope(bytes: Buffer, keyPath: string): MasterKey {
  if (bytes.length !== ENVELOPE_BYTES || bytes[0] !== ENVELOPE_VERSION) {
    throw new DomainError(
      'INTEGRITY_ERROR',
      `${keyPath} unwrapped to something that is not a v${ENVELOPE_VERSION} master key envelope, so the file is corrupt. Delete the secrets folder and re-paste your LinkedIn token in the dashboard (Capabilities area).`,
      { blockers: ['master_key_corrupt'] },
    );
  }
  return {
    keyId: `mk_${bytes.subarray(1, 1 + KEY_ID_BYTES).toString('hex')}`,
    key: bytes.subarray(1 + KEY_ID_BYTES),
  };
}

/**
 * How the master-key envelope is sealed on this host.
 *
 * Windows hands it to DPAPI. Everywhere else it is sealed under a key derived
 * from the machine id and the calling user — see machineKey.ts for why that is
 * the shape, and for the one property it gives up relative to DPAPI.
 *
 * The envelope either side handles is identical, so the only thing that varies
 * between platforms is the seal. Nothing downstream of `parseEnvelope` knows
 * which one ran.
 */
export interface KeyWrapper {
  /** One name per scheme, so a folder carried between platforms is simply not found. */
  readonly fileName: string;
  wrap(envelope: Buffer, keyPath: string): Promise<string>;
  unwrap(stored: string, keyPath: string): Promise<Buffer>;
}

export function dpapiKeyWrapper(): KeyWrapper {
  return {
    fileName: MASTER_KEY_FILE_DPAPI,
    // The file holds base64, not the raw DPAPI blob: it is what crosses stdin
    // on the way back in, and a text file survives being opened by a curious
    // editor.
    wrap: async (envelope, keyPath) =>
      (await dpapi('Protect', envelope.toString('base64'), keyPath)).toString('base64'),
    unwrap: async (stored, keyPath) => await dpapi('Unprotect', stored, keyPath),
  };
}

export function machineKeyWrapper(identity: MachineIdentity): KeyWrapper {
  // Derived once per wrapper. It is not written anywhere, and it is recomputed
  // from scratch in the next process.
  const kek = deriveKeyEncryptionKey(identity);
  return {
    fileName: MASTER_KEY_FILE_MACHINE,
    wrap: (envelope) => Promise.resolve(wrapWithMachineKey(envelope, kek).toString('base64')),
    unwrap: (stored, keyPath) =>
      Promise.resolve(unwrapWithMachineKey(Buffer.from(stored, 'base64'), kek, keyPath)),
  };
}

/**
 * The macOS vault. The key-encryption key is random and held by the login
 * Keychain; the file beside the database holds only the envelope sealed under
 * it. That is the strongest of the three, because the key is neither derivable
 * nor reproducible — see keychain.ts.
 */
export function keychainKeyWrapper(run?: KeychainRunner): KeyWrapper {
  // One Keychain round trip per wrapper, not per operation, and cleared on
  // failure so a locked keychain that is then unlocked does not stay broken for
  // the life of the process.
  let pending: Promise<Buffer> | null = null;
  const kek = async (): Promise<Buffer> => {
    pending ??= readOrCreateKeychainKey(run);
    try {
      return await pending;
    } catch (error) {
      pending = null;
      throw error;
    }
  };
  return {
    fileName: MASTER_KEY_FILE_KEYCHAIN,
    wrap: async (envelope) => sealKey(envelope, await kek()).toString('base64'),
    unwrap: async (stored, keyPath) =>
      openKey(Buffer.from(stored, 'base64'), await kek(), {
        keyPath,
        remedy:
          'did not authenticate against the key this Mac holds in its login Keychain. That key is random and never leaves the Keychain, so a secrets folder copied from another Mac, or written by another account, can never be opened here. Delete that folder and paste your LinkedIn token again in the dashboard (Capabilities area).',
        failureBlocker: 'keychain_unwrap_failed',
      }),
  };
}

/** The file name alone, which is knowable without building a wrapper or reaching the OS. */
export function masterKeyFileName(platform: string = process.platform): string {
  if (platform === 'win32') return MASTER_KEY_FILE_DPAPI;
  if (platform === 'darwin') return MASTER_KEY_FILE_KEYCHAIN;
  return MASTER_KEY_FILE_MACHINE;
}

export function hostKeyWrapper(platform: string = process.platform): KeyWrapper {
  if (platform === 'win32') return dpapiKeyWrapper();
  if (platform === 'darwin') return keychainKeyWrapper();
  if (platform === 'linux') {
    return machineKeyWrapper({ machineId: readMachineId(), uid: userInfo().uid });
  }
  // Named rather than assumed. A BSD has neither a machine-id file nor a
  // Keychain, and guessing would produce a vault whose guarantees nobody has
  // stated.
  throw new DomainError(
    'INTERNAL',
    `the credential vault has no key protection for ${platform}; LinkedIn credentials cannot be stored on this platform, and the rest of the product works without them`,
    { blockers: ['vault_unsupported_platform'] },
  );
}

async function resolveMasterKey(keyPath: string, wrapper: KeyWrapper): Promise<MasterKey> {
  if (existsSync(keyPath)) {
    const stored = readFileSync(keyPath, 'utf8').trim();
    return parseEnvelope(await wrapper.unwrap(stored, keyPath), keyPath);
  }
  mkdirSync(dirname(keyPath), { recursive: true });
  const envelope = Buffer.concat([
    Buffer.of(ENVELOPE_VERSION),
    randomBytes(KEY_ID_BYTES),
    randomBytes(AES_KEY_BYTES),
  ]);
  const wrapped = await wrapper.wrap(envelope, keyPath);
  try {
    // 'wx': if another process created the key while this one was sealing its
    // own, that process's key is the authoritative one — clobbering it would
    // strand every row it has already encrypted. The window is ~200ms on
    // Windows, where sealing spawns PowerShell, and microseconds elsewhere.
    writeFileSync(keyPath, wrapped, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const winner = readFileSync(keyPath, 'utf8').trim();
    return parseEnvelope(await wrapper.unwrap(winner, keyPath), keyPath);
  }
  return parseEnvelope(envelope, keyPath);
}

// The name and key id are authenticated but not encrypted, so a ciphertext
// lifted out of the read-lane row and pasted into the write-lane row fails to
// decrypt instead of silently swapping tokens between two LinkedIn apps.
function additionalData(name: string, keyId: string): Buffer {
  return Buffer.from(`${name}\0${keyId}`, 'utf8');
}

function blobColumn(row: Row, column: string, name: string): Buffer {
  const value = row[column];
  if (!(value instanceof Uint8Array)) {
    throw new DomainError(
      'INTEGRITY_ERROR',
      `secret '${name}' has a non-binary ${column} column, so the row was written by something other than this store. Delete it and re-paste the value in the dashboard (Capabilities area).`,
      { blockers: ['secret_row_corrupt'] },
    );
  }
  return Buffer.from(value);
}

export interface SecretStoreOptions {
  /** Injectable so both wrapping schemes can be exercised on either platform. */
  wrapper?: KeyWrapper;
  platform?: string;
}

export function createSecretStore(
  db: SqliteDriver,
  home: string,
  options: SecretStoreOptions = {},
): SecretStore {
  const platform = options.platform ?? process.platform;
  const keyPath = join(home, 'secrets', options.wrapper?.fileName ?? masterKeyFileName(platform));

  // One PowerShell round trip per process rather than per operation: spawning
  // the interpreter costs ~200ms, and the dashboard pastes a client id and a
  // token together. `pending` collapses callers that arrive during that spawn.
  let cached: MasterKey | null = null;
  let pending: Promise<MasterKey> | null = null;
  let wrapper: KeyWrapper | null = options.wrapper ?? null;

  async function masterKey(): Promise<MasterKey> {
    if (cached !== null) return cached;
    // Built on first use rather than at construction. A host where the vault
    // cannot work — no machine id, an unsupported platform — must still run
    // everything that does not need a credential, and constructing the store
    // is not asking for one.
    if (wrapper === null) wrapper = hostKeyWrapper(platform);
    pending ??= resolveMasterKey(keyPath, wrapper);
    try {
      cached = await pending;
      return cached;
    } finally {
      // Cleared on failure too, so a transient PowerShell problem does not
      // poison the store for the life of the process.
      pending = null;
    }
  }

  return {
    async put(name: string, value: string): Promise<void> {
      if (!STORABLE_NAMES.includes(name)) {
        throw new DomainError(
          'INVALID_INPUT',
          `'${name}' is not a storable secret; this store holds only ${STORABLE_NAMES.join(', ')}`,
          { blockers: ['unknown_secret_name'] },
        );
      }
      // Pasted tokens routinely carry a trailing newline, which becomes an
      // invalid Authorization header hours later and looks like a revoked
      // credential.
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        throw new DomainError(
          'INVALID_INPUT',
          `refusing to store an empty value for '${name}'; paste the value again in the dashboard (Capabilities area)`,
          { blockers: ['empty_secret'] },
        );
      }

      const { key, keyId } = await masterKey();
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(additionalData(name, keyId));
      const ciphertext = Buffer.concat([cipher.update(trimmed, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const now = new Date().toISOString();

      withWriteTx(db, () => {
        db.run(
          `INSERT INTO secrets (name, ciphertext, iv, auth_tag, key_id, created_at, rotated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT (name) DO UPDATE SET
             ciphertext = excluded.ciphertext,
             iv = excluded.iv,
             auth_tag = excluded.auth_tag,
             key_id = excluded.key_id,
             rotated_at = ?`,
          name,
          ciphertext,
          iv,
          authTag,
          keyId,
          now,
          now,
        );
      });
    },

    async get(name: string): Promise<string | null> {
      const row = db.get(
        'SELECT ciphertext, iv, auth_tag, key_id FROM secrets WHERE name = ?',
        name,
      );
      if (row === undefined) return null;

      // Checked before touching DPAPI so an unknown name never costs a spawn,
      // and so a crypto-erased home (purgeEverything deletes secrets/) reports
      // the real cause instead of minting a fresh key that decrypts nothing.
      if (!existsSync(keyPath)) {
        throw new DomainError(
          'INTEGRITY_ERROR',
          `secret '${name}' is stored but ${keyPath} is gone, so its ciphertext is permanently unrecoverable — that is exactly what a full local purge does. Re-paste the value in the dashboard (Capabilities area).`,
          { blockers: ['master_key_missing'] },
        );
      }

      const { key, keyId } = await masterKey();
      const rowKeyId = String(row['key_id']);
      if (rowKeyId !== keyId) {
        throw new DomainError(
          'INTEGRITY_ERROR',
          `secret '${name}' was encrypted under master key ${rowKeyId} but this home now holds ${keyId}. DPAPI material is bound to this Windows user and machine, so a database and a secrets folder from different origins cannot be mixed. Re-paste the value in the dashboard (Capabilities area).`,
          { blockers: ['master_key_mismatch'] },
        );
      }

      const decipher = createDecipheriv('aes-256-gcm', key, blobColumn(row, 'iv', name));
      decipher.setAAD(additionalData(name, rowKeyId));
      decipher.setAuthTag(blobColumn(row, 'auth_tag', name));
      // Read before the try, with its siblings. Inside it, a text column in a
      // restored database was reported as a failed authentication — the same
      // remedy, but the wrong cause, and the member had no way to learn the row
      // did not come from this store.
      const ciphertext = blobColumn(row, 'ciphertext', name);
      try {
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return plaintext.toString('utf8');
      } catch {
        // The underlying error is swallowed rather than wrapped: it carries no
        // detail the member can act on, and it is the one place a crypto
        // library could echo input back into a message we surface.
        throw new DomainError(
          'INTEGRITY_ERROR',
          `secret '${name}' failed authenticated decryption: the row was altered after it was written, or its ciphertext was moved from another name. Re-paste the value in the dashboard (Capabilities area).`,
          { blockers: ['secret_auth_failed'] },
        );
      }
    },

    has(name: string): boolean {
      return db.get('SELECT 1 AS present FROM secrets WHERE name = ?', name) !== undefined;
    },

    async remove(name: string): Promise<void> {
      withWriteTx(db, () => {
        db.run('DELETE FROM secrets WHERE name = ?', name);
      });
    },

    listNames(): string[] {
      return db.all('SELECT name FROM secrets ORDER BY name').map((row) => String(row['name']));
    },
  };
}
