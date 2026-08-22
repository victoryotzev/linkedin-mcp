import { posix as posixPath, win32 as win32Path } from 'node:path';

export interface DataHomeEnvironment {
  LINKEDIN_MCP_HOME?: string;
  /** Windows. */
  LOCALAPPDATA?: string;
  /** Linux, per the XDG Base Directory specification. */
  XDG_DATA_HOME?: string;
  HOME?: string;
}

/** The application directory name, under whichever base the platform uses. */
const APPLICATION_DIRECTORY = 'linkedin-mcp';

/**
 * Resolves the one application home used by the MCP server, dashboard, and
 * explicit human CLI commands.
 *
 * A configured home must be absolute. Accepting a relative value would make
 * two MCP hosts with different working directories open different databases
 * while both appeared to use the same configuration.
 *
 * `platform` is a parameter rather than a read of `process.platform` so both
 * defaults can be tested from either host. The path rules differ between them
 * — `C:\x` is not absolute to POSIX and `/x` is absolute to Windows — so a test
 * that could only run on its own platform would prove the wrong thing.
 */
export function resolveDataHome(
  env: DataHomeEnvironment = process.env,
  platform: string = process.platform,
): string {
  const configured = env.LINKEDIN_MCP_HOME?.trim();
  if (configured) return normalizeAbsolute(configured, 'LINKEDIN_MCP_HOME', platform);

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (!localAppData) {
      throw new Error(
        'Neither LINKEDIN_MCP_HOME nor LOCALAPPDATA is set; cannot locate the LinkedIn app data directory',
      );
    }
    return normalizeAbsolute(
      win32Path.join(localAppData, APPLICATION_DIRECTORY),
      'LOCALAPPDATA',
      platform,
    );
  }

  // XDG first on both POSIX platforms, including macOS. It is not the Apple
  // convention, but a member who has set XDG_DATA_HOME has said where
  // application data goes on their machine, and overruling that would be this
  // product deciding it knows better.
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg) {
    return normalizeAbsolute(posixPath.join(xdg, APPLICATION_DIRECTORY), 'XDG_DATA_HOME', platform);
  }
  const home = env.HOME?.trim();
  if (!home) {
    throw new Error(
      'None of LINKEDIN_MCP_HOME, XDG_DATA_HOME or HOME is set; cannot locate the LinkedIn app data directory',
    );
  }
  // Otherwise each platform's own convention: Apple documents
  // ~/Library/Application Support for exactly this, and it is where a Mac user
  // and Mac tooling both expect to find it. Elsewhere, the location the XDG
  // specification says to assume when the variable is unset.
  const relative =
    platform === 'darwin'
      ? [home, 'Library', 'Application Support', APPLICATION_DIRECTORY]
      : [home, '.local', 'share', APPLICATION_DIRECTORY];
  return normalizeAbsolute(posixPath.join(...relative), 'HOME', platform);
}

function normalizeAbsolute(value: string, variable: string, platform: string): string {
  const path = platform === 'win32' ? win32Path : posixPath;
  if (!path.isAbsolute(value)) {
    throw new Error(
      `${variable} must be an absolute path so every MCP client and the dashboard open the same data`,
    );
  }
  // `isAbsolute` is not enough on Windows. It returns true for a drive-RELATIVE
  // path — `/data/x` or `\data\x`, which have a root of `\` but no drive — and
  // such a path resolves against whatever drive each process happens to be on.
  // An MCP client launched from C: and the dashboard from D: would then open
  // two different databases while both looked correctly configured, which is
  // the exact split this rule exists to prevent. Require a real root: a drive
  // letter, or a UNC `\\server\share`.
  if (platform === 'win32' && !/^([A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(value)) {
    throw new Error(
      `${variable} must start with a drive letter (C:\\...) or a UNC share (\\\\server\\share\\...); a drive-relative path like ${value} resolves against whichever drive a process is on, so different clients would open different data`,
    );
  }
  const normalized = path.normalize(value);
  const root = path.parse(normalized).root;
  if (normalized === root) {
    throw new Error(
      `${variable} cannot be a filesystem root; choose a dedicated application folder`,
    );
  }
  // Trailing separators come off by scanning back, not by `/[\\/]+$/`. That
  // regex is quadratic on a long run of separators that is not at the end —
  // the engine retries the whole run from each position — and this value comes
  // from an environment variable or a `-DataHome` argument, so its length is
  // not this function's to assume. The loop is linear and does the same thing.
  let end = normalized.length;
  while (end > 0) {
    const character = normalized[end - 1];
    if (character !== '\\' && character !== '/') break;
    end -= 1;
  }
  return normalized.slice(0, end);
}
