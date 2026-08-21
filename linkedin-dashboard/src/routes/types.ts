import type { Context } from 'hono';
import type { ArtifactStore, SqliteDriver } from '@linkedin-mcp/db';
import type { Lane, SecretStorePort } from '@linkedin-mcp/domain';
import type { ToolDef } from '@linkedin-mcp/server/dashboard';
import { DomainError } from '@linkedin-mcp/shared';

export interface ApiDeps {
  db: SqliteDriver;
  store: ArtifactStore;
  fts5: boolean;
  /** The data home. Needed by the routes that touch backups on disk. */
  home?: string;
  // Optional so tests and non-Windows environments can build the app without
  // secret storage; the endpoints that need them fail closed when absent.
  secretStore?: SecretStorePort;
  probeLane?: (
    lane: Lane,
    token: string,
  ) => Promise<{ ok: true; person_urn?: string } | { ok: false; status: number; message: string }>;
  /** Closes the database and ends the process. Only the full-purge route uses it. */
  shutdown?: () => void;
  /** Exact MCP registry exposed through the authenticated advanced console. */
  tools?: readonly ToolDef[];
}

export interface Page {
  limit: number;
  offset: number;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * Paging happens here, in the transport layer, and never by adding a default
 * limit to a domain list function.
 *
 * The MCP server does the same thing (`pageFromArray` over an unbounded call),
 * and the reason matters: `listClaims` and `listArtifacts` are shared with the
 * tool surface, so a default limit on either would silently truncate the
 * evidence corpus the model reasons over. A partial corpus that looks complete
 * is the one failure this product cannot tolerate.
 */
export function page(c: Context): Page {
  const limit = Number(c.req.query('limit') ?? DEFAULT_LIMIT);
  const offset = Number(c.req.query('offset') ?? 0);
  return {
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
    offset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
  };
}

export function paginate<T>(
  rows: T[],
  { limit, offset }: Page,
): { items: T[]; total: number; has_more: boolean } {
  const items = rows.slice(offset, offset + limit);
  return { items, total: rows.length, has_more: offset + items.length < rows.length };
}

/**
 * Every mutation requires an explicit `confirm: true`.
 *
 * The session cookie is already SameSite=Strict and the guard already demands
 * same-origin, so this is belt and braces — but it also means no state-changing
 * route can be triggered by a bare request that happens to arrive, and the
 * requirement is uniform enough to be asserted across the whole surface by one
 * test rather than reviewed route by route.
 */
export async function confirmedBody<T extends Record<string, unknown>>(c: Context): Promise<T> {
  const body = await c.req
    .json<T & { confirm?: boolean }>()
    .catch(() => ({}) as T & { confirm?: boolean });
  if (body.confirm !== true) {
    throw new DomainError(
      'INVALID_INPUT',
      'this action changes state and must be confirmed explicitly (confirm: true)',
      { blockers: ['confirmation_required'] },
    );
  }
  return body;
}
