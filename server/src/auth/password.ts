import { randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

// scrypt with N=2^15, r=8: about 32 MB and tens of milliseconds per hash —
// slow enough to resist guessing, fast enough for five people logging in.
const N = 32_768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;

function scrypt(password: string, salt: Buffer, n = N, r = R, p = P): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize('NFKC'), salt, KEY_LENGTH, { N: n, r, p, maxmem: MAX_MEMORY }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

/** Stored format: scrypt$N$r$p$saltBase64$hashBase64 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

let dummyHash: Promise<string> | undefined;
/**
 * A hash to verify against when the username does not exist, so a failed
 * login takes the same time whether or not the account is real.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString('base64'));
  return dummyHash;
}

/** Returns a problem to show the user, or null if the password is acceptable. */
export function passwordProblem(password: string, username: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  // Only meaningful for usernames of 4+ characters; a 2-letter name like "kk" would forbid too much.
  if (username.length >= 4 && password.toLowerCase().includes(username.toLowerCase())) return 'Do not include your username.';
  if (new Set(password).size < 5) return 'Use a less repetitive password.';
  return null;
}

// No 0/O, 1/l/I: easy to read aloud or copy by hand.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A one-time password the admin hands over; the user must change it at first sign-in. */
export function generateTemporaryPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}
