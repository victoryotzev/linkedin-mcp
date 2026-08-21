import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

// Built client assets, read into memory and served from there.
//
// Deliberately not @hono/node-server's serveStatic: serving from memory has no
// filesystem path handling at all, so there is no traversal surface on the one
// authenticated local surface that can approve a publication. It is also
// independent of process cwd, which differs between `npm run dashboard` (runs
// in linkedin-dashboard) and the test suite (runs at the repo root).
//
// A missing build is a hard failure at construction rather than a blank page,
// because a dashboard that renders nothing is a dashboard that cannot approve
// anything.

export const CLIENT_ASSETS = ['app.js', 'app.css', 'theme-boot.js'] as const;
export type AssetName = (typeof CLIENT_ASSETS)[number];

export interface Asset {
  // A plain Uint8Array, not a Buffer: Hono's body type is
  // `Uint8Array<ArrayBuffer>`, and Node's Buffer is `Uint8Array<ArrayBufferLike>`,
  // which does not satisfy it. Copied once at load; these files are tens of KB.
  readonly body: Uint8Array<ArrayBuffer>;
  /** Content hash, embedded in the URL so assets can be cached immutably. */
  readonly hash: string;
  readonly contentType: string;
  /** `/assets/app-<hash>.js` */
  readonly url: string;
}

export interface AssetProvider {
  /** Asset name -> hashed URL, for the shell to reference. */
  manifest(): Record<AssetName, string>;
  /** Resolves the `:file` segment of `/assets/:file`. Null when it matches no current asset. */
  resolve(file: string): Asset | null;
}

export class MissingClientBuildError extends Error {
  constructor(readonly path: string) {
    super(
      `dashboard client asset not found: ${path}\n` +
        'Build it first: npm run build -w @linkedin-mcp/dashboard',
    );
    this.name = 'MissingClientBuildError';
  }
}

const CONTENT_TYPES: Record<AssetName, string> = {
  'app.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'theme-boot.js': 'text/javascript; charset=utf-8',
};

function hashedUrl(name: AssetName, hash: string): string {
  const dot = name.lastIndexOf('.');
  return `/assets/${name.slice(0, dot)}-${hash}${name.slice(dot)}`;
}

interface CacheEntry {
  asset: Asset;
  mtimeMs: number;
  size: number;
}

/**
 * @param dir  directory holding the tsup output (linkedin-dashboard/dist/client)
 * @param opts.watch  re-read when the file changes on disk. On in development,
 *   where tsup rebuilds the client without restarting the server; off in normal
 *   runs, where the bytes cannot change under us.
 */
export function createAssetProvider(dir: string, opts: { watch?: boolean } = {}): AssetProvider {
  const watch = opts.watch ?? false;
  const cache = new Map<AssetName, CacheEntry>();

  const load = (name: AssetName): Asset => {
    const cached = cache.get(name);
    if (cached && !watch) return cached.asset;

    const path = join(dir, name);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(path);
    } catch {
      throw new MissingClientBuildError(path);
    }
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.asset;
    }

    const body = Uint8Array.from(readFileSync(path));
    const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
    const asset: Asset = {
      body,
      hash,
      contentType: CONTENT_TYPES[name],
      url: hashedUrl(name, hash),
    };
    cache.set(name, { asset, mtimeMs: stat.mtimeMs, size: stat.size });
    return asset;
  };

  // Eager, so a missing or partial build fails at startup with an actionable
  // message rather than on the first page load.
  for (const name of CLIENT_ASSETS) load(name);

  return {
    manifest() {
      const out = {} as Record<AssetName, string>;
      for (const name of CLIENT_ASSETS) out[name] = load(name).url;
      return out;
    },
    resolve(file) {
      const wanted = basename(file);
      for (const name of CLIENT_ASSETS) {
        const asset = load(name);
        // Compared against the CURRENT hash, so a request carrying a stale hash
        // 404s instead of being served new bytes under an old immutable URL.
        if (basename(asset.url) === wanted) return asset;
      }
      return null;
    },
  };
}
