import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@linkedin-mcp/shared';

describe('canonicalJson', () => {
  it('sorts object keys deterministically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('is byte-stable across nested structures', () => {
    const one = canonicalJson({ z: [1, { b: 'x', a: null }], a: true });
    const two = canonicalJson({ a: true, z: [1, { a: null, b: 'x' }] });
    expect(one).toBe(two);
    expect(one).toBe('{"a":true,"z":[1,{"a":null,"b":"x"}]}');
  });

  it('drops undefined object members', () => {
    expect(canonicalJson({ a: 1, gone: undefined })).toBe('{"a":1}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
  });
});
