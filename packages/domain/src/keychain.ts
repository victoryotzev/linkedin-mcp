import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { DomainError } from '@linkedin-mcp/shared';
import { KEK_BYTES } from './sealedKey.ts';

// The macOS vault: the key-encryption key lives in the login Keychain.
//
// This is the closest analogue to DPAPI of the three platforms, and stronger
// than the Linux derivation: the key is random rather than reproducible, and
// the OS holds it behind an access-control list instead of it being derivable
// from a world-readable file. A data home copied to another Mac, or read by
// another account, has no way to obtain it.
//
// The item is created with `-T /usr/bin/security`, which puts that binary on
// the item's ACL, so later reads by the same binary do not raise an
// authorization dialog. That matters more here than it looks: an MCP client
// starts this server with no terminal and no user watching, and a vault that
// can pop a modal is a vault that can hang the server.
//
// Absolute path to `security` for the same reason the DPAPI code uses an
// absolute path to powershell.exe: a binary planted earlier on PATH would
// otherwise be handed key material.

const SECURITY_BIN = '/usr/bin/security';
const KEYCHAIN_SERVICE = 'linkedin-mcp';
const KEYCHAIN_ACCOUNT = 'master-key-encryption-key';
const KEYCHAIN_LABEL = 'LinkedIn Evidence MCP master key';
const KEYCHAIN_TIMEOUT_MS = 15_000;

/** `security` exits 44 when the item simply is not there — a first run, not a failure. */
const NOT_FOUND_EXIT = 44;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export interface KeychainResult {
  code: number | null;
  stdout: string;
}

/** Injected by tests so every branch here is reachable without a Mac. */
export type KeychainRunner = (args: readonly string[]) => Promise<KeychainResult>;

function runSecurity(args: readonly string[]): Promise<KeychainResult> {
  return new Promise<KeychainResult>((resolve, reject) => {
    const child = spawn(SECURITY_BIN, [...args]);
    const chunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, KEYCHAIN_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    // Drained and discarded: `security` writes its own diagnostics here and
    // they can quote the item back. The exit code is the diagnostic we use.
    child.stderr?.resume();
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new DomainError(
            'INTERNAL',
            `the Keychain did not answer within ${KEYCHAIN_TIMEOUT_MS}ms and was killed. If an authorization dialog is waiting, answer it and retry; if this persists, delete the "${KEYCHAIN_LABEL}" item from Keychain Access and paste your LinkedIn token again.`,
            { blockers: ['keychain_timeout'], retryable: true },
          ),
        );
        return;
      }
      resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

/**
 * Fetches the key-encryption key from the login Keychain, creating a random one
 * on first use.
 *
 * The value crosses argv on creation, which on Windows would be unacceptable —
 * the DPAPI path goes to some length to avoid exactly that. macOS is different
 * in a way worth stating rather than assuming: `kern.procargs2` restricts a
 * process's arguments to the same user and root, both of which are already
 * named as out of scope in SECURITY.md. What crosses is also a random KEK, not
 * a LinkedIn token.
 */
export async function readOrCreateKeychainKey(run: KeychainRunner = runSecurity): Promise<Buffer> {
  const found = await lookup(run);
  if (found !== null) return found;

  const created = randomBytes(KEK_BYTES).toString('base64');
  const add = await run([
    'add-generic-password',
    '-a',
    KEYCHAIN_ACCOUNT,
    '-s',
    KEYCHAIN_SERVICE,
    '-l',
    KEYCHAIN_LABEL,
    '-D',
    'application key',
    // Puts `security` itself on the item's ACL, so reads never prompt.
    '-T',
    SECURITY_BIN,
    // Update in place rather than failing if a racing process got there first.
    '-U',
    '-w',
    created,
  ]);
  if (add.code !== 0) {
    throw new DomainError(
      'INTERNAL',
      `the Keychain refused to store the vault key (security exited ${String(add.code)}), so no secret was stored. Check that the login keychain is unlocked.`,
      { blockers: ['keychain_store_failed'] },
    );
  }

  // Read back rather than trusting what we just wrote: `-U` means a racing
  // process may have written a different key a moment earlier, and its key is
  // the one every row it encrypted is sealed under.
  const winner = await lookup(run);
  if (winner === null) {
    throw new DomainError(
      'INTERNAL',
      'the Keychain accepted the vault key and then did not return it, so the vault cannot be trusted on this host',
      { blockers: ['keychain_readback_failed'] },
    );
  }
  return winner;
}

async function lookup(run: KeychainRunner): Promise<Buffer | null> {
  const result = await run([
    'find-generic-password',
    '-a',
    KEYCHAIN_ACCOUNT,
    '-s',
    KEYCHAIN_SERVICE,
    '-w',
  ]);
  if (result.code === NOT_FOUND_EXIT) return null;
  if (result.code !== 0) {
    throw new DomainError(
      'INTERNAL',
      `the Keychain could not be read (security exited ${String(result.code)}). If the login keychain is locked, unlock it and retry.`,
      { blockers: ['keychain_unavailable'], retryable: true },
    );
  }
  const encoded = result.stdout.trim();
  if (!BASE64_RE.test(encoded)) {
    throw new DomainError(
      'INTEGRITY_ERROR',
      `the "${KEYCHAIN_LABEL}" Keychain item is not the value this product wrote. Delete it in Keychain Access, delete the secrets folder, and paste your LinkedIn token again.`,
      { blockers: ['keychain_item_malformed'] },
    );
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== KEK_BYTES) {
    throw new DomainError(
      'INTEGRITY_ERROR',
      `the "${KEYCHAIN_LABEL}" Keychain item is ${key.length} bytes, not ${KEK_BYTES}. Delete it in Keychain Access, delete the secrets folder, and paste your LinkedIn token again.`,
      { blockers: ['keychain_item_malformed'] },
    );
  }
  return key;
}

export const KEYCHAIN_ITEM = {
  service: KEYCHAIN_SERVICE,
  account: KEYCHAIN_ACCOUNT,
  label: KEYCHAIN_LABEL,
} as const;
