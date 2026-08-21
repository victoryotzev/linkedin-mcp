import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import { DomainError } from '@linkedin-mcp/shared';

// Windows-aware path admission control for evidence source roots and
// root-relative subpaths. Everything here fails closed with PATH_REJECTED.
//
// Rejected at intake (before any filesystem access):
//   - UNC paths (\\server\share) and device/verbatim prefixes (\\?\, \\.\)
//   - NTFS alternate data streams (any ':' beyond the drive designator)
//   - reserved device names (CON, NUL, COM1, ...) in any segment
//   - relative paths
// Then canonicalized with realpathSync.native, which resolves junctions,
// symlinks, 8.3 short names (DESKTO~1), and normalizes drive-letter case.

const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;

function rejectRawShape(raw: string): void {
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    throw new DomainError('PATH_REJECTED', `UNC/device path refused: ${raw}`);
  }
  if (!isAbsolute(raw) || !/^[A-Za-z]:[\\/]/.test(raw)) {
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

export function canonicalizePath(raw: string): string {
  rejectRawShape(raw);
  let canonical: string;
  try {
    canonical = realpathSync.native(raw);
  } catch {
    throw new DomainError('PATH_REJECTED', `path does not exist or is unreadable: ${raw}`);
  }
  // realpath output must still satisfy the same shape rules (a symlink could
  // have pointed at a UNC target).
  rejectRawShape(canonical);
  return canonical;
}

// Per-segment, case-insensitive containment. Never a string-prefix check:
// C:\Evi must not contain C:\EvidenceEvil.
export function isContainedIn(root: string, candidate: string): boolean {
  const rootSegs = root
    .toLowerCase()
    .split(sep)
    .filter((s) => s.length > 0);
  const candSegs = candidate
    .toLowerCase()
    .split(sep)
    .filter((s) => s.length > 0);
  if (candSegs.length < rootSegs.length) return false;
  return rootSegs.every((seg, i) => candSegs[i] === seg);
}

export function assertContained(root: string, candidate: string): string {
  const canonical = canonicalizePath(candidate);
  if (!isContainedIn(root, canonical)) {
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
