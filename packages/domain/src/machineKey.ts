import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { DomainError } from '@linkedin-mcp/shared';

// The Linux stand-in for DPAPI.
//
// Windows wraps the master key with DPAPI CurrentUser: no passphrase, bound to
// the account and the machine, so a secrets folder copied elsewhere is inert.
// Linux has no equivalent that works without either a passphrase the member
// would have to type on every MCP start, or a keyring daemon that does not
// exist on a headless box.
//
// So the key-encryption key is derived, never stored: HKDF over the host's
// machine id and the calling user's id. That reproduces the two properties the
// product actually relies on —
//
//   - nothing to unlock, so an MCP client can still start the server itself;
//   - a data home copied to another machine cannot be decrypted there, because
//     the machine id stayed behind.
//
// It is weaker than DPAPI in one way, and the documentation says so rather than
// implying parity: `/etc/machine-id` is world-readable, so any process on the
// box can derive the same key. DPAPI at least makes an attacker ask the OS.
// Neither defends against code running as the member, which SECURITY.md has
// always listed as out of scope.
//
// Reimaging the host changes the machine id and strands the stored secrets,
// which is the same outcome Windows has after a profile loss. The remedy is
// identical: delete the secrets folder and paste the token again.

const WRAP_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEK_BYTES = 32;

// Fixed, non-secret, and versioned. Changing either string changes every
// derived key, so they are part of the on-disk format rather than decoration.
const KEK_SALT = 'linkedin-mcp/machine-key/salt/v1';
const KEK_INFO = 'linkedin-mcp/machine-key/master-key-encryption-key/v1';

/**
 * systemd writes the first; the second is the older D-Bus location that still
 * exists on systems without systemd. Both are host-scoped and survive reboots,
 * which is the property being borrowed.
 */
export const MACHINE_ID_PATHS = ['/etc/machine-id', '/var/lib/dbus/machine-id'] as const;

export interface MachineIdentity {
  /** Host-scoped, stable across reboots, absent from a copied data home. */
  machineId: string;
  /** Separates two accounts on one host, the way DPAPI CurrentUser does. */
  uid: number;
}

/**
 * Reads the host's machine id.
 *
 * `paths` is injectable so the failure modes can be tested on any platform —
 * a machine id that is missing, empty, or not the 32 hex characters the format
 * specifies are three different problems and produce three different messages.
 */
export function readMachineId(paths: readonly string[] = MACHINE_ID_PATHS): string {
  const found = paths.find((path) => existsSync(path));
  if (found === undefined) {
    throw new DomainError(
      'INTERNAL',
      `no machine id was found at ${paths.join(' or ')}, so the credential vault cannot derive its key on this host; the rest of the product works without stored credentials`,
      { blockers: ['machine_id_unavailable'] },
    );
  }
  const raw = readFileSync(found, 'utf8').trim();
  if (raw.length === 0) {
    throw new DomainError(
      'INTERNAL',
      `${found} is empty, so the credential vault has nothing to derive a key from`,
      { blockers: ['machine_id_empty'] },
    );
  }
  // A machine id is 32 lowercase hex characters. Anything else means the file
  // is not what it claims to be, and deriving a key from it anyway would put
  // the vault's whole guarantee on a value nobody has checked.
  if (!/^[0-9a-f]{32}$/.test(raw)) {
    throw new DomainError(
      'INTERNAL',
      `${found} does not contain a 32-character hexadecimal machine id, so the credential vault will not derive a key from it`,
      { blockers: ['machine_id_malformed'] },
    );
  }
  return raw;
}

/**
 * Derives the key-encryption key. Pure: same identity in, same key out, and
 * nothing written anywhere.
 */
export function deriveKeyEncryptionKey(identity: MachineIdentity): Buffer {
  if (!Number.isInteger(identity.uid) || identity.uid < 0) {
    throw new DomainError(
      'INTERNAL',
      `a non-negative integer user id is required to derive the vault key, got ${String(identity.uid)}`,
      { blockers: ['machine_key_bad_uid'] },
    );
  }
  const derived = hkdfSync(
    'sha256',
    Buffer.from(identity.machineId, 'utf8'),
    Buffer.from(KEK_SALT, 'utf8'),
    Buffer.from(`${KEK_INFO}/uid=${identity.uid}`, 'utf8'),
    KEK_BYTES,
  );
  return Buffer.from(derived);
}

/** `[version][nonce][tag][ciphertext]`, so the shape is checked before the tag is. */
export function wrapWithMachineKey(plaintext: Buffer, kek: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce);
  // The version travels as additional authenticated data as well as in the
  // header, so a blob relabelled as another version fails to authenticate
  // rather than being parsed under rules it was not written with.
  cipher.setAAD(Buffer.of(WRAP_VERSION));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.of(WRAP_VERSION), nonce, cipher.getAuthTag(), ciphertext]);
}

export function unwrapWithMachineKey(wrapped: Buffer, kek: Buffer, keyPath: string): Buffer {
  const header = 1 + NONCE_BYTES + TAG_BYTES;
  if (wrapped.length <= header || wrapped[0] !== WRAP_VERSION) {
    throw new DomainError(
      'INTEGRITY_ERROR',
      `${keyPath} is not a v${WRAP_VERSION} machine-wrapped master key. A secrets folder written on Windows, or by another build, cannot be opened here. Delete that folder and paste your LinkedIn token again in the dashboard (Capabilities area).`,
      { blockers: ['machine_key_bad_format'] },
    );
  }
  const nonce = wrapped.subarray(1, 1 + NONCE_BYTES);
  const tag = wrapped.subarray(1 + NONCE_BYTES, header);
  const ciphertext = wrapped.subarray(header);
  const decipher = createDecipheriv('aes-256-gcm', kek, nonce);
  decipher.setAAD(Buffer.of(WRAP_VERSION));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new DomainError(
      'INTEGRITY_ERROR',
      `${keyPath} did not authenticate against this host's key. The vault key is derived from the machine id and your user id, so a secrets folder copied from another machine or written by another account can never be opened here, and a reimaged host counts as another machine. Delete that folder and paste your LinkedIn token again in the dashboard (Capabilities area).`,
      { blockers: ['machine_key_unwrap_failed'] },
    );
  }
}
