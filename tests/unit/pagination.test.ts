import { describe, expect, it } from 'vitest';
import { DomainError } from '@linkedin-mcp/shared';
import {
  decodeOffsetCursor,
  encodeOffsetCursor,
  pageFromArray,
} from '../../linkedin-mcp-server/src/pagination.ts';

describe('pagination', () => {
  it('walks a full result set via cursors without loss or duplication', () => {
    const all = Array.from({ length: 10 }, (_, i) => i);
    const seen: number[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = pageFromArray(all, cursor, 3);
      seen.push(...page.items);
      if (!page.has_more) {
        expect(page.next_cursor).toBeUndefined();
        break;
      }
      expect(page.next_cursor).toBeDefined();
      cursor = page.next_cursor;
    }
    expect(seen).toEqual(all);
  });

  it('rejects malformed cursors', () => {
    expect(() => decodeOffsetCursor('not-base64url-of-int!')).toThrowError(DomainError);
    expect(() => decodeOffsetCursor(Buffer.from('-5').toString('base64url'))).toThrowError(
      DomainError,
    );
  });

  it('round-trips encoded offsets', () => {
    expect(decodeOffsetCursor(encodeOffsetCursor(42))).toBe(42);
  });
});
