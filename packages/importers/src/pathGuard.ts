import { lstatSync, realpathSync } from 'node:fs';
import { DomainError } from '@linkedin-mcp/shared';

// Path admission control for evidence source roots and root-relative subpaths.
// Everything here fails closed with PATH_REJECTED.
//
// The rules differ by platform because the dangerous shapes differ by platform,
// not because one is stricter than the other. Which set applies is a parameter
// rather than a read of `process.platform`, so both can be tested anywhere —
// the Windows rules are exercised on Linux CI and the POSIX rules on Windows,
// which is the only way either set stays honest.
//
// Windows rejects at intake, before any filesystem access:
//   - UNC paths (\\server\share) and device/verbatim prefixes (\\?\, \\.\)
//   - anything that is not an absolute drive-letter path
//   - NTFS alternate data streams (any ':' beyond the drive designator)
//   - reserved device names (CON, NUL, COM1, ...) in any segment
//
// POSIX rejects:
//   - anything not rooted at '/'
//   - a leading '//', whose meaning the standard leaves to the implementation
//   - embedded NUL, which truncates the path inside libc and makes what was
//     checked differ from what is opened
//
// A colon is an ordinary filename character on POSIX and a reserved device name
// is a Windows concept, so neither rule crosses over. Both platforms then
// canonicalize with realpathSync.native, which resolves symlinks — and on
// Windows also junctions, 8.3 short names (DESKTO~1), and drive-letter case.

export type PathPlatform = 'win32' | 'posix';

export function hostPathPlatform(platform: string = process.platform): PathPlatform {
  return platform === 'win32' ? 'win32' : 'posix';
}

const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

function rejectWindowsShape(raw: string): void {
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    throw new DomainError('PATH_REJECTED', `UNC/device path refused: ${raw}`);
  }
  if (!/^[A-Za-z]:[\\/]/.test(raw)) {
    throw new DomainError('PATH_REJECTED', `only absolute drive-letter paths are accepted: ${raw}`);
  }
  const afterDrive = raw.slice(2);
  if (afterDrive.includes(':')) {
    throw new DomainError('PATH_REJECTED', `alternate data stream / extra colon refused: ${raw}`);
  }
  for (const segment of afterDrive.split(/[\\/]/)) {
    if (RESERVED.test(segment)) {
      throw new DomainError('PATH_REJECTED', `reserved device name in path: ${segment}`);
    }
  }
}

function rejectPosixShape(raw: string): void {
  if (raw.includes('\0')) {
    // libc stops at the NUL, so the path that gets opened is a prefix of the
    // one that was checked. Refused rather than truncated: the caller asked
    // for something this code cannot honestly validate.
    throw new DomainError('PATH_REJECTED', 'path contains an embedded NUL byte');
  }
  if (!raw.startsWith('/')) {
    throw new DomainError('PATH_REJECTED', `only absolute paths are accepted: ${raw}`);
  }
  if (raw.startsWith('//') && !raw.startsWith('///')) {
    // POSIX leaves exactly two leading slashes implementation-defined. Refused
    // for the same reason UNC is refused on Windows: the root is ambiguous.
    throw new DomainError('PATH_REJECTED', `ambiguous double-slash root refused: ${raw}`);
  }
}

/**
 * The shape rules alone, with no filesystem access. Exported because it is the
 * half that can be tested for either platform from either platform.
 */
export function assertAcceptableShape(
  raw: string,
  platform: PathPlatform = hostPathPlatform(),
): void {
  if (platform === 'win32') rejectWindowsShape(raw);
  else rejectPosixShape(raw);
}

export function canonicalizePath(raw: string, platform: PathPlatform = hostPathPlatform()): string {
  assertAcceptableShape(raw, platform);
  let canonical: string;
  try {
    canonical = realpathSync.native(raw);
  } catch {
    throw new DomainError('PATH_REJECTED', `path does not exist or is unreadable: ${raw}`);
  }
  // realpath output must still satisfy the same shape rules: a symlink could
  // have pointed at a UNC target, or out of the rooted world entirely.
  assertAcceptableShape(canonical, platform);
  return canonical;
}

/**
 * Per-segment containment. Never a string-prefix check: C:\Evi must not contain
 * C:\EvidenceEvil.
 *
 * Case folding follows the platform rather than the host. Windows paths are
 * compared case-insensitively because the filesystem is; POSIX paths are not,
 * because on Linux `/data/Evidence` and `/data/evidence` are two directories
 * and folding them together would report containment that does not exist.
 *
 * macOS sits between the two: APFS is case-insensitive by default and can be
 * formatted case-sensitive, so neither answer is right for every volume. It is
 * treated as POSIX, which errs toward refusing containment rather than
 * inventing it — the safe direction. In practice the question rarely arises,
 * because both sides of this comparison come from `realpathSync.native`, which
 * returns the casing the filesystem actually stored.
 */
export function isContainedIn(
  root: string,
  candidate: string,
  platform: PathPlatform = hostPathPlatform(),
): boolean {
  const split = (value: string): string[] =>
    (platform === 'win32' ? value.toLowerCase() : value).split(/[\\/]/).filter((s) => s.length > 0);
  const rootSegs = split(root);
  const candSegs = split(candidate);
  if (candSegs.length < rootSegs.length) return false;
  return rootSegs.every((seg, i) => candSegs[i] === seg);
}

export function assertContained(
  root: string,
  candidate: string,
  platform: PathPlatform = hostPathPlatform(),
): string {
  const canonical = canonicalizePath(candidate, platform);
  if (!isContainedIn(root, canonical, platform)) {
    throw new DomainError('PATH_REJECTED', `path escapes its registered source root: ${candidate}`);
  }
  return canonical;
}

// Reparse points (junctions, symlinks) are skipped during scans unless their
// resolved target stays inside the root — the classic symlink-escape defense.
export function isReparsePoint(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return true; // unreadable -> treat as unsafe
  }
}
