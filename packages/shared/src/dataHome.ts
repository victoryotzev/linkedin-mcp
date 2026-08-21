import { isAbsolute, join, normalize, parse } from 'node:path';

export interface DataHomeEnvironment {
  LINKEDIN_MCP_HOME?: string;
  LOCALAPPDATA?: string;
}

/**
 * Resolves the one application home used by the MCP server, dashboard, and
 * explicit human CLI commands.
 *
 * A configured home must be absolute. Accepting a relative value would make
 * two MCP hosts with different working directories open different databases
 * while both appeared to use the same configuration.
 */
export function resolveDataHome(env: DataHomeEnvironment = process.env): string {
  const configured = env.LINKEDIN_MCP_HOME?.trim();
  if (configured) return normalizeAbsolute(configured, 'LINKEDIN_MCP_HOME');

  const localAppData = env.LOCALAPPDATA?.trim();
  if (!localAppData) {
    throw new Error(
      'Neither LINKEDIN_MCP_HOME nor LOCALAPPDATA is set; cannot locate the LinkedIn app data directory',
    );
  }
  return normalizeAbsolute(join(localAppData, 'linkedin-mcp'), 'LOCALAPPDATA');
}

function normalizeAbsolute(value: string, variable: string): string {
  if (!isAbsolute(value)) {
    throw new Error(
      `${variable} must be an absolute path so every MCP client and the dashboard open the same data`,
    );
  }
  const normalized = normalize(value);
  const root = parse(normalized).root;
  if (normalized === root) {
    throw new Error(
      `${variable} cannot be a filesystem root; choose a dedicated application folder`,
    );
  }
  return normalized.replace(/[\\/]+$/, '');
}
