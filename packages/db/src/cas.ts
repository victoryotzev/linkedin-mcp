import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { DomainError } from '@linkedin-mcp/shared';

export interface PutResult {
  sha256: string;
  path: string;
  existed: boolean;
}

// Content-addressed artifact store. Originals are copied here byte-for-byte,
// named by their own hash, then marked read-only. Immutability guarantees:
// write-once naming, read-only attribute, and hash re-verification on every
// read (mismatch fails closed — INTEGRITY_ERROR).
export class ArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  pathFor(sha256: string): string {
    return join(this.#root, 'sha256', sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  put(bytes: Uint8Array): PutResult {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const path = this.pathFor(sha256);
    if (existsSync(path)) {
      // Verify before trusting. existsSync alone made a corrupted stored file
      // permanently unrepairable: re-importing the same bytes short-circuited
      // here, the import layer reported 'duplicate', and purge refused while
      // any non-rejected claim cited the artifact — so the only escape was
      // deleting the file by hand. Size first because it is the cheap check.
      const healthy =
        statSync(path).size === bytes.length &&
        createHash('sha256').update(readFileSync(path)).digest('hex') === sha256;
      if (healthy) return { sha256, path, existed: true };
      // Stored bytes are damaged; the caller handed us the correct ones, so
      // heal rather than fail. The read-only attribute has to come off first.
      chmodSync(path, 0o644);
      rmSync(path, { force: true });
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, bytes);
    try {
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      // Concurrent writer with identical content-addressed bytes won the race.
      if (existsSync(path)) return { sha256, path, existed: true };
      throw err;
    }
    chmodSync(path, 0o444);
    return { sha256, path, existed: false };
  }

  read(sha256: string): Uint8Array {
    const path = this.pathFor(sha256);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch (err) {
      // Only a genuinely absent file is NOT_FOUND. Reporting EACCES, EBUSY or
      // EIO as "not in the store" sent the operator off to re-import a file
      // that is present — and the importer then short-circuits as a duplicate,
      // so the advice could never work.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new DomainError('NOT_FOUND', `artifact ${sha256} is not in the store`);
      }
      throw new DomainError(
        'INTERNAL',
        `artifact ${sha256} could not be read (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}); the file is present but unreadable`,
        { retryable: true },
      );
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== sha256) {
      throw new DomainError(
        'INTEGRITY_ERROR',
        `artifact ${sha256} failed hash verification (stored bytes hash to ${actual}); refusing to serve tampered content`,
      );
    }
    return bytes;
  }

  has(sha256: string): boolean {
    return existsSync(this.pathFor(sha256));
  }

  // Purge is the ONLY way bytes leave the store; the read-only attribute is
  // cleared explicitly so the deletion is a deliberate act, never a stray
  // overwrite. Callers must first prove no artifact row still references the
  // hash (see purgeArtifact).
  delete(sha256: string): boolean {
    const path = this.pathFor(sha256);
    if (!existsSync(path)) return false;
    chmodSync(path, 0o644);
    rmSync(path, { force: true });
    return true;
  }
}
