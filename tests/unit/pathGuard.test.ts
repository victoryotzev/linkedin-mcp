import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertContained,
  canonicalizePath,
  isContainedIn,
  isReparsePoint,
} from '@linkedin-mcp/importers';
import { DomainError } from '@linkedin-mcp/shared';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'linkedin-mcp-guard-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
  return 'NO_ERROR';
}

describe('pathGuard', () => {
  it('rejects UNC and device paths', () => {
    expect(codeOf(() => canonicalizePath('\\\\server\\share\\x'))).toBe('PATH_REJECTED');
    expect(codeOf(() => canonicalizePath('\\\\?\\C:\\Windows'))).toBe('PATH_REJECTED');
    expect(codeOf(() => canonicalizePath('\\\\.\\PhysicalDrive0'))).toBe('PATH_REJECTED');
    expect(codeOf(() => canonicalizePath('//server/share'))).toBe('PATH_REJECTED');
  });

  it('rejects alternate data streams and reserved device names', () => {
    expect(codeOf(() => canonicalizePath('C:\\temp\\file.txt:hidden'))).toBe('PATH_REJECTED');
    expect(codeOf(() => canonicalizePath('C:\\temp\\CON'))).toBe('PATH_REJECTED');
    expect(codeOf(() => canonicalizePath('C:\\temp\\NUL.txt'))).toBe('PATH_REJECTED');
    expect(codeOf(() => canonicalizePath('C:\\temp\\COM1'))).toBe('PATH_REJECTED');
  });

  // The assertions above all name paths that do not exist, so realpathSync
  // throws ENOENT and they would pass with the shape checks deleted entirely.
  // These two use fixtures that really exist, so the shape check is the only
  // thing that can reject them — and each carries a control proving the same
  // path IS accepted without the hostile shape.
  it('rejects a real alternate data stream, not merely a missing path', () => {
    const base = join(root, 'file.txt');
    writeFileSync(base, 'visible content');
    const ads = `${base}:hidden`;
    writeFileSync(ads, 'payload smuggled in a stream');

    expect(codeOf(() => canonicalizePath(ads))).toBe('PATH_REJECTED');
    // Control: the base file is accepted, so the rejection is about the stream.
    expect(canonicalizePath(base).length).toBeGreaterThan(0);
  });

  it('rejects a verbatim \\\\?\\ prefix on a directory that really exists', () => {
    expect(codeOf(() => canonicalizePath(`\\\\?\\${root}`))).toBe('PATH_REJECTED');
    // Control: the same directory without the prefix canonicalizes fine.
    expect(canonicalizePath(root).length).toBeGreaterThan(0);
  });

  it('rejects relative paths and nonexistent paths', () => {
    expect(codeOf(() => canonicalizePath('relative\\path'))).toBe('PATH_REJECTED');
    expect(codeOf(() => canonicalizePath(join(root, 'does-not-exist')))).toBe('PATH_REJECTED');
  });

  it('canonicalizes real paths and containment is per-segment, case-insensitive', () => {
    const canonical = canonicalizePath(root);
    expect(isContainedIn(canonical, canonical)).toBe(true);

    mkdirSync(join(root, 'inside'));
    const child = canonicalizePath(join(root, 'inside'));
    expect(isContainedIn(canonical, child)).toBe(true);
    expect(isContainedIn(canonical, child.toUpperCase())).toBe(true);

    // Prefix trap: root 'abc' must not contain sibling 'abcdef'.
    const sibling = mkdtempSync(`${root}-sibling-`);
    try {
      expect(isContainedIn(canonical, canonicalizePath(sibling))).toBe(false);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('assertContained refuses escapes via dot-dot traversal', () => {
    mkdirSync(join(root, 'sub'));
    const canonical = canonicalizePath(root);
    expect(codeOf(() => assertContained(canonical, join(root, 'sub', '..', '..')))).toBe(
      'PATH_REJECTED',
    );
  });

  it('detects junctions as reparse points (symlink-escape defense)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'linkedin-mcp-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'outside data');
      const junction = join(root, 'jump');
      symlinkSync(outside, junction, 'junction');
      expect(isReparsePoint(junction)).toBe(true);
      // And assertContained on the junction's resolved target escapes the root.
      expect(codeOf(() => assertContained(canonicalizePath(root), junction))).toBe('PATH_REJECTED');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
