import { describe, expect, it } from 'vitest';
import { isId, newId, ulid } from '@linkedin-mcp/shared';

describe('ids', () => {
  it('produces 26-char Crockford ULIDs with prefixes', () => {
    const id = newId('clm');
    expect(id).toMatch(/^clm_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isId(id)).toBe(true);
    expect(isId(id, 'clm')).toBe(true);
    expect(isId(id, 'art')).toBe(false);
  });

  it('sorts lexically by timestamp', () => {
    const earlier = ulid(1_000_000_000_000);
    const later = ulid(2_000_000_000_000);
    expect(earlier < later).toBe(true);
  });

  it('does not collide across a burst', () => {
    const seen = new Set(Array.from({ length: 5000 }, () => newId('art')));
    expect(seen.size).toBe(5000);
  });
});
