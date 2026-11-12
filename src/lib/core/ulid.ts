/**
 * Minimal ULID generator (https://github.com/ulid/spec): a 48-bit millisecond
 * timestamp + 80 bits of crypto randomness, Crockford base32, 26 characters.
 *
 * Uniqueness is what the sync/chat dedupe actually relies on (80 random bits
 * makes collisions negligible); the timestamp keeps ids roughly sortable.
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ENCODING[t % 32] + time;
    t = Math.floor(t / 32);
  }

  // 16 base32 characters carry 80 bits. `byte % 32` is unbiased because 256
  // (the byte range) is an exact multiple of 32.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let random = '';
  for (let i = 0; i < 16; i++) {
    random += ENCODING[bytes[i] % 32];
  }

  return time + random;
}
