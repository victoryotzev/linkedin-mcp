import { readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { isReparsePoint } from './pathGuard.ts';

// Repository scanner: work-tree files only (never git history — deleted
// secrets stay dead), vendored/build directories skipped, reparse points
// skipped (junction/symlink escape defense). Two products:
//   1. a pattern-scoped file list worth ingesting as evidence artifacts
//      (manifests, docs, CI configs — what claims actually cite)
//   2. deterministic repo stats (file counts per extension) as structured
//      evidence of scale, without copying entire source trees into the store.

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  'venv',
  'out',
  'target',
  'vendor',
]);

// Hidden directories are caches/state/vendored trees essentially always
// (.git, .venv, .local-training-data, .hypothesis, .claude, ...). The one
// hidden dir with evidence value is .github (CI workflows).
function shouldSkipDir(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === '.github') return false;
  return lower.startsWith('.') || SKIP_DIRS.has(lower);
}

const EVIDENCE_FILES = [
  /^readme(\..+)?$/i,
  /^package\.json$/,
  /^pyproject\.toml$/,
  /^requirements[^/]*\.txt$/i,
  /^tsconfig[^/]*\.json$/,
  /^cargo\.toml$/i,
  /^docker-compose[^/]*\.ya?ml$/i,
  /^dockerfile$/i,
  /^security(\..+)?$/i,
  /^license(\..+)?$/i,
  /^changelog(\..+)?$/i,
];

const EVIDENCE_DIR_FILES: Array<{ dir: RegExp; file: RegExp }> = [
  { dir: /^\.github[\\/]workflows$/i, file: /\.ya?ml$/i },
  { dir: /^docs([\\/]|$)/i, file: /\.(md|rst)$/i },
];

export interface RepoScanResult {
  evidenceFiles: string[]; // relpaths worth ingesting
  stats: {
    files_total: number;
    files_by_extension: Record<string, number>;
    dirs_skipped: string[];
    reparse_points_skipped: string[];
  };
}

export function scanRepo(root: string, maxFileBytes: number): RepoScanResult {
  const evidenceFiles: string[] = [];
  const byExt: Record<string, number> = {};
  const dirsSkipped: string[] = [];
  const reparseSkipped: string[] = [];
  let total = 0;

  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      const rel = relative(root, full);
      if (isReparsePoint(full)) {
        reparseSkipped.push(rel);
        continue;
      }
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (shouldSkipDir(name)) {
          dirsSkipped.push(rel);
        } else {
          stack.push(full);
        }
        continue;
      }
      total += 1;
      const ext = extname(name).toLowerCase() || '(none)';
      byExt[ext] = (byExt[ext] ?? 0) + 1;

      if (st.size > maxFileBytes) continue;
      const isTopLevelEvidence =
        !rel.includes('\\') && !rel.includes('/') && EVIDENCE_FILES.some((re) => re.test(name));
      const relDir = rel.slice(0, Math.max(0, rel.length - name.length - 1));
      const isDirEvidence = EVIDENCE_DIR_FILES.some(
        ({ dir: dre, file: fre }) => dre.test(relDir) && fre.test(name),
      );
      if (isTopLevelEvidence || isDirEvidence) evidenceFiles.push(rel);
    }
  }

  evidenceFiles.sort();
  return {
    evidenceFiles,
    stats: {
      files_total: total,
      files_by_extension: byExt,
      dirs_skipped: dirsSkipped.sort(),
      reparse_points_skipped: reparseSkipped.sort(),
    },
  };
}
