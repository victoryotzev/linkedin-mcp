import { describe, expect, it } from 'vitest';
import {
  assertAcceptableShape,
  hostPathPlatform,
  isContainedIn,
  type PathPlatform,
} from '@linkedin-mcp/importers';
import { DomainError } from '@linkedin-mcp/shared';

// Both rule sets, from either host.
//
// The shape checks take the platform as an argument, so the Windows rules run
// on a Linux runner and the POSIX rules run on a Windows one. That is the whole
// point: a guard that could only be tested on the platform it protects would be
// proved by exactly the machines least likely to break it.

function refusal(raw: string, platform: PathPlatform): DomainError {
  try {
    assertAcceptableShape(raw, platform);
  } catch (error) {
    return error as DomainError;
  }
  return expect.unreachable(`${platform} should have refused ${JSON.stringify(raw)}`);
}

describe('choosing a rule set', () => {
  it('treats every non-Windows platform as POSIX', () => {
    expect(hostPathPlatform('win32')).toBe('win32');
    expect(hostPathPlatform('linux')).toBe('posix');
    expect(hostPathPlatform('darwin')).toBe('posix');
    expect(hostPathPlatform('freebsd')).toBe('posix');
  });
});

describe('the Windows rules', () => {
  it('accepts an absolute drive-letter path', () => {
    expect(() => assertAcceptableShape('C:\\Users\\alex\\cv.pdf', 'win32')).not.toThrow();
    expect(() => assertAcceptableShape('D:/evidence', 'win32')).not.toThrow();
  });

  it('refuses UNC and device paths', () => {
    expect(refusal('\\\\server\\share', 'win32').message).toMatch(/UNC\/device/i);
    expect(refusal('\\\\?\\C:\\x', 'win32').message).toMatch(/UNC\/device/i);
    expect(refusal('//server/share', 'win32').message).toMatch(/UNC\/device/i);
  });

  it('refuses a POSIX path, which is the whole reason Linux needed its own rules', () => {
    expect(refusal('/home/alex/cv.pdf', 'win32').message).toMatch(/drive-letter/i);
  });

  it('refuses an alternate data stream', () => {
    expect(refusal('C:\\evidence\\cv.pdf:hidden', 'win32').message).toMatch(
      /alternate data stream/i,
    );
  });

  it('refuses a reserved device name in any segment', () => {
    expect(refusal('C:\\evidence\\NUL', 'win32').message).toMatch(/reserved device name/i);
    expect(refusal('C:\\COM1\\cv.pdf', 'win32').message).toMatch(/reserved device name/i);
    expect(refusal('C:\\evidence\\con.txt', 'win32').message).toMatch(/reserved device name/i);
  });

  it('refuses a relative path', () => {
    expect(refusal('evidence\\cv.pdf', 'win32').message).toMatch(/drive-letter/i);
    expect(refusal('..\\..\\etc', 'win32').message).toMatch(/drive-letter/i);
  });
});

describe('the POSIX rules', () => {
  it('accepts an absolute path', () => {
    expect(() => assertAcceptableShape('/home/alex/cv.pdf', 'posix')).not.toThrow();
    expect(() => assertAcceptableShape('/', 'posix')).not.toThrow();
  });

  it('refuses a relative path', () => {
    expect(refusal('home/alex', 'posix').message).toMatch(/only absolute paths/i);
    expect(refusal('../etc/passwd', 'posix').message).toMatch(/only absolute paths/i);
  });

  it('refuses a Windows path, so a copied configuration fails loudly', () => {
    expect(refusal('C:\\Users\\alex', 'posix').message).toMatch(/only absolute paths/i);
  });

  it('refuses an embedded NUL, which libc would silently truncate at', () => {
    // The path that gets opened would be a prefix of the one that was checked.
    expect(refusal('/home/alex\0/../../etc/shadow', 'posix').message).toMatch(/NUL/i);
  });

  it('refuses the ambiguous double-slash root the standard leaves undefined', () => {
    expect(refusal('//host/share', 'posix').message).toMatch(/double-slash/i);
  });

  it('accepts three or more leading slashes, which POSIX defines as one', () => {
    expect(() => assertAcceptableShape('///home/alex', 'posix')).not.toThrow();
  });

  it('accepts a colon, which is an ordinary filename character here', () => {
    // The Windows alternate-data-stream rule must not cross over: refusing this
    // would make perfectly normal Linux files unimportable.
    expect(() => assertAcceptableShape('/home/alex/notes:2026.md', 'posix')).not.toThrow();
  });

  it('accepts a name Windows reserves, because Linux does not', () => {
    expect(() => assertAcceptableShape('/home/alex/NUL', 'posix')).not.toThrow();
    expect(() => assertAcceptableShape('/srv/com1/data.csv', 'posix')).not.toThrow();
  });
});

describe('containment', () => {
  it('is per-segment on both platforms, never a string prefix', () => {
    expect(isContainedIn('C:\\Evi', 'C:\\EvidenceEvil\\x', 'win32')).toBe(false);
    expect(isContainedIn('/data/evi', '/data/evidenceevil/x', 'posix')).toBe(false);
  });

  it('accepts a real descendant', () => {
    expect(isContainedIn('C:\\evidence', 'C:\\evidence\\cv\\a.pdf', 'win32')).toBe(true);
    expect(isContainedIn('/data/evidence', '/data/evidence/cv/a.pdf', 'posix')).toBe(true);
  });

  it('accepts the root itself', () => {
    expect(isContainedIn('C:\\evidence', 'C:\\evidence', 'win32')).toBe(true);
    expect(isContainedIn('/data/evidence', '/data/evidence', 'posix')).toBe(true);
  });

  it('folds case on Windows, because the filesystem does', () => {
    expect(isContainedIn('C:\\Evidence', 'c:\\evidence\\cv.pdf', 'win32')).toBe(true);
  });

  it('does NOT fold case on POSIX, because two directories can differ only by case', () => {
    // Folding here would report containment that does not exist: /data/Evidence
    // and /data/evidence are different directories on Linux, and treating one
    // as inside the other is how a source escapes its registered root.
    expect(isContainedIn('/data/Evidence', '/data/evidence/cv.pdf', 'posix')).toBe(false);
    expect(isContainedIn('/data/evidence', '/data/Evidence/cv.pdf', 'posix')).toBe(false);
  });

  it('refuses a sibling and a parent on both platforms', () => {
    expect(isContainedIn('C:\\evidence', 'C:\\other\\cv.pdf', 'win32')).toBe(false);
    expect(isContainedIn('C:\\evidence\\deep', 'C:\\evidence', 'win32')).toBe(false);
    expect(isContainedIn('/data/evidence', '/data/other/cv.pdf', 'posix')).toBe(false);
    expect(isContainedIn('/data/evidence/deep', '/data/evidence', 'posix')).toBe(false);
  });

  it('does not treat a POSIX backslash as a separator', () => {
    // A backslash is an ordinary filename character on POSIX. `/data/evi\evil`
    // is a sibling of `/data/evi`, not a child — splitting it on backslash made
    // its segments prefix-match the root and reported containment, which is how
    // an import escapes its registered source root.
    expect(isContainedIn('/data/evi', String.raw`/data/evi\evil/x`, 'posix')).toBe(false);
    // And the inverse: a root whose own name contains a backslash still contains
    // its real children rather than a differently-structured path.
    expect(isContainedIn(String.raw`/srv/a\b`, String.raw`/srv/a\b/cv.pdf`, 'posix')).toBe(true);
    expect(isContainedIn(String.raw`/srv/a\b`, '/srv/a/b/cv.pdf', 'posix')).toBe(false);
    // On Windows the backslash IS a separator, so the same sibling shape is a
    // real descendant there — the platforms genuinely differ.
    expect(isContainedIn('C:\\data\\evi', 'C:\\data\\evi\\evil\\x', 'win32')).toBe(true);
  });

  it('folds only ASCII case on Windows, so an exotic codepoint cannot collapse two dirs', () => {
    // `String.toLowerCase` folds U+212A KELVIN SIGN to 'k', but NTFS keeps
    // `eviK` (U+212A) and `evik` as distinct directories. Folding them together
    // would report a file in the sibling as contained in the root — a bypass of
    // the same boundary the reparse-point defence protects. Both sides here come
    // from realpathSync.native in practice, where only ASCII case ever differs.
    const kelvin = '\u212A';
    expect(isContainedIn(`C:\\data\\evi${kelvin}`, 'C:\\data\\evik\\secret.txt', 'win32')).toBe(
      false,
    );
    // ASCII case still folds, which is all the real filesystem needs.
    expect(isContainedIn('C:\\Data\\Evi', 'c:\\data\\evi\\cv.pdf', 'win32')).toBe(true);
  });
});
