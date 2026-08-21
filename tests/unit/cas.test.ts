import { Buffer } from 'node:buffer';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '@linkedin-mcp/db';
import { DomainError } from '@linkedin-mcp/shared';

let root: string;
let store: ArtifactStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'linkedin-mcp-cas-'));
  store = new ArtifactStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

describe('ArtifactStore', () => {
  // existsSync alone made a damaged stored file permanently unrepairable:
  // re-putting the correct bytes short-circuited, the import layer called it a
  // duplicate, and purge refused while a claim cited it.
  it('heals a corrupted stored file when the correct bytes are put again', () => {
    const bytes = Buffer.from('the original artifact bytes');
    const { sha256, path } = store.put(bytes);
    chmodSync(path, 0o644);
    writeFileSync(path, '');
    expect(() => store.read(sha256)).toThrowError(/INTEGRITY|hash verification/i);

    const again = store.put(bytes);
    expect(again.existed).toBe(false);
    expect(Buffer.from(store.read(sha256)).toString()).toBe('the original artifact bytes');
  });

  it('reports an unreadable-but-present file as INTERNAL, not NOT_FOUND', () => {
    const { sha256, path } = store.put(Buffer.from('locked bytes'));
    rmSync(path, { force: true });
    mkdirSync(path, { recursive: true }); // a directory where a file belongs -> EISDIR
    let code = 'NO_ERROR';
    try {
      store.read(sha256);
    } catch (err) {
      code = err instanceof DomainError ? err.code : 'OTHER';
    }
    expect(code).toBe('INTERNAL');
  });

  it('round-trips bytes and reports duplicates', () => {
    const bytes = new TextEncoder().encode('evidence bytes');
    const first = store.put(bytes);
    expect(first.existed).toBe(false);
    expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);

    const second = store.put(bytes);
    expect(second.existed).toBe(true);
    expect(second.sha256).toBe(first.sha256);

    expect(Buffer.from(store.read(first.sha256)).toString()).toBe('evidence bytes');
  });

  it('fails closed when stored bytes are tampered with', () => {
    const { sha256, path } = store.put(new TextEncoder().encode('original'));
    chmodSync(path, 0o644);
    writeFileSync(path, 'tampered');
    expect(() => store.read(sha256)).toThrowError(DomainError);
    try {
      store.read(sha256);
    } catch (err) {
      expect((err as DomainError).code).toBe('INTEGRITY_ERROR');
    }
  });

  it('reports NOT_FOUND for unknown hashes', () => {
    expect(() => store.read('0'.repeat(64))).toThrowError(DomainError);
    try {
      store.read('0'.repeat(64));
    } catch (err) {
      expect((err as DomainError).code).toBe('NOT_FOUND');
    }
  });
});
