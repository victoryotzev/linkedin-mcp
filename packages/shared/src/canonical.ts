// Canonical JSON: deterministic byte representation used for content hashes
// (draft revisions, approvals, audit chain). Object keys sorted, no whitespace,
// rejects values that cannot round-trip deterministically.
export type Jsonish =
  | null
  | boolean
  | number
  | string
  | Jsonish[]
  | { [key: string]: Jsonish | undefined };

export function canonicalJson(value: Jsonish): string {
  return encode(value);
}

function encode(value: Jsonish | undefined): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('canonicalJson: non-finite number');
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
      throw new TypeError('canonicalJson: undefined is not representable');
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => encode(v)).join(',')}]`;
      }
      const keys = Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort();
      const body = keys.map((k) => `${JSON.stringify(k)}:${encode(value[k])}`);
      return `{${body.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}
