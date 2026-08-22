import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DomainError } from '@linkedin-mcp/shared';

// Sealing the master-key envelope under a key-encryption key.
//
// Shared by both non-Windows vaults, because only the *custody* of the KEK
// differs between them: Linux derives it from the machine id and uid, macOS
// takes a random one the Keychain holds. The sealing itself is the same, so it
// lives in one place rather than being written twice and drifting.
//
// Windows does not use this. DPAPI seals the envelope itself, and reproducing
// that with our own construction would be replacing an OS guarantee with one
// nobody has reviewed.

const SEAL_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
export const KEK_BYTES = 32;

/** `[version][nonce][tag][ciphertext]`, so the shape is checked before the tag is. */
export function sealKey(plaintext: Buffer, kek: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce);
  // The version travels as additional authenticated data as well as in the
  // header, so a blob relabelled as another version fails to authenticate
  // rather than being parsed under rules it was not written with.
  cipher.setAAD(Buffer.of(SEAL_VERSION));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.of(SEAL_VERSION), nonce, cipher.getAuthTag(), ciphertext]);
}

export interface OpenKeyContext {
  /** The file being opened, named in both failure messages. */
  keyPath: string;
  /** Why this key might not open here, and what to do — appended to the failure. */
  remedy: string;
  /** Blocker for an authentication failure, so callers can tell the two apart. */
  failureBlocker: string;
}

export function openKey(wrapped: Buffer, kek: Buffer, context: OpenKeyContext): Buffer {
  const header = 1 + NONCE_BYTES + TAG_BYTES;
  if (wrapped.length <= header || wrapped[0] !== SEAL_VERSION) {
    throw new DomainError(
      'INTEGRITY_ERROR',
      `${context.keyPath} is not a v${SEAL_VERSION} sealed master key. A secrets folder written on another platform, or by another build, cannot be opened here. Delete that folder and paste your LinkedIn token again in the dashboard (Capabilities area).`,
      { blockers: ['sealed_key_bad_format'] },
    );
  }
  const nonce = wrapped.subarray(1, 1 + NONCE_BYTES);
  const tag = wrapped.subarray(1 + NONCE_BYTES, header);
  const ciphertext = wrapped.subarray(header);
  const decipher = createDecipheriv('aes-256-gcm', kek, nonce);
  decipher.setAAD(Buffer.of(SEAL_VERSION));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new DomainError('INTEGRITY_ERROR', `${context.keyPath} ${context.remedy}`, {
      blockers: [context.failureBlocker],
    });
  }
}
