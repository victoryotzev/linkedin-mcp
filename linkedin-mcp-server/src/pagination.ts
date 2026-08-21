import { DomainError } from '@linkedin-mcp/shared';

// Cursor conventions shared by every list tool: opaque base64url cursors,
// default limit 25, max 100, results carry has_more/next_cursor.
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export interface Page<T> {
  items: T[];
  has_more: boolean;
  next_cursor?: string;
}

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

export function decodeOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const offset = Number.parseInt(text, 10);
  if (!Number.isInteger(offset) || offset < 0 || String(offset) !== text) {
    throw new DomainError('INVALID_INPUT', 'malformed pagination cursor');
  }
  return offset;
}

export function pageFromArray<T>(
  all: readonly T[],
  cursor: string | undefined,
  limit: number,
): Page<T> {
  const start = decodeOffsetCursor(cursor);
  const items = all.slice(start, start + limit);
  const nextStart = start + items.length;
  const hasMore = nextStart < all.length;
  return {
    items: [...items],
    has_more: hasMore,
    ...(hasMore ? { next_cursor: encodeOffsetCursor(nextStart) } : {}),
  };
}
