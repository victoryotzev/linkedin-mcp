import { randomBytes } from 'node:crypto';

// ULID: 48-bit ms timestamp + 80 bits randomness, Crockford base32, lexically
// sortable. Prefixed per entity so an ID is self-describing in logs and URIs.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type IdPrefix =
  | 'src'
  | 'run'
  | 'art'
  | 'ext'
  | 'clm'
  | 'cfl'
  | 'rev'
  | 'snp'
  | 'chg'
  | 'pat'
  | 'drf'
  | 'val'
  | 'cov'
  | 'cal'
  | 'apv'
  | 'pub'
  | 'obs'
  // One live read of the LinkedIn Data Portability lane. Distinct from 'obs'
  // (analytics observations) so the two never share an identifier space.
  | 'dmo'
  | 'cap'
  | 'acc'
  | 'tok';

export function ulid(now: number = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = randomBytes(10);
  let out = '';
  // 80 random bits -> 16 base32 chars: consume 5 bits at a time.
  let bits = 0;
  let acc = 0;
  for (const byte of rand) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return time + out.slice(0, 16);
}

export function newId(prefix: IdPrefix, now?: number): string {
  return `${prefix}_${ulid(now)}`;
}

const ID_RE = /^[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isId(value: string, prefix?: IdPrefix): boolean {
  if (!ID_RE.test(value)) return false;
  return prefix === undefined || value.startsWith(`${prefix}_`);
}
