import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashSessionToken } from '../src/auth/sessions.js';
import { ADMIN_PASSWORD, Client, createAdmin, resetDatabase, startApp, TEST_SECRET, testPool } from './helpers.js';

const db = testPool();
let server: Server;
let base = '';

beforeAll(async () => {
  ({ server, base } = await startApp(db));
});
beforeEach(async () => {
  await resetDatabase(db);
  await createAdmin(db);
});
afterAll(async () => {
  server.close();
  await db.end();
});

describe('sign-in', () => {
  it('signs in with the right password and sets a locked-down cookie', async () => {
    const c = new Client(base);
    const res = await c.login('boss', ADMIN_PASSWORD);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ username: 'boss', role: 'admin', mustChangePassword: false });
    expect(res.body.user.password_hash).toBeUndefined();
    expect(res.setCookie).toMatch(/cvu_session=/);
    expect(res.setCookie).toMatch(/HttpOnly/i);
    expect(res.setCookie).toMatch(/SameSite=Strict/i);
    expect((await c.get('/api/auth/me')).body.user.username).toBe('boss');
  });

  it('accepts the username in any case and with spaces around it', async () => {
    expect((await new Client(base).login('  BOSS ', ADMIN_PASSWORD)).status).toBe(200);
  });

  it('gives the same answer for a wrong password and an unknown user', async () => {
    const wrong = await new Client(base).login('boss', 'not-the-password');
    const unknown = await new Client(base).login('nobody', 'not-the-password');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual({ error: 'invalid_credentials' });
    expect(unknown.body).toEqual(wrong.body);
  });

  it('stores only an HMAC of the session token, never the token', async () => {
    const c = new Client(base);
    await c.login('boss', ADMIN_PASSWORD);
    const token = c.cookie.split('=')[1]!;
    const rows = (await db.query<{ token_hash: string }>('SELECT token_hash FROM auth_sessions')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toBe(token);
    expect(rows[0]!.token_hash).toBe(hashSessionToken(token, TEST_SECRET));
  });

  it('blocks an address after 5 failures in 15 minutes, even with the right password', async () => {
    const c = new Client(base);
    for (let i = 0; i < 5; i++) expect((await c.login('boss', `wrong-${i}`)).status).toBe(401);
    const blocked = await c.login('boss', ADMIN_PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toBe('too_many_attempts');
  });

  it('records successes and failures in the audit log, without passwords', async () => {
    await new Client(base).login('boss', 'wrong-password-1');
    await new Client(base).login('boss', ADMIN_PASSWORD);
    const rows = (await db.query<{ action: string; details: unknown }>('SELECT action, details FROM audit_log ORDER BY id')).rows;
    expect(rows.map((r) => r.action)).toEqual(['login_failed', 'login_succeeded']);
    expect(JSON.stringify(rows)).not.toContain('wrong-password-1');
    expect(JSON.stringify(rows)).not.toContain(ADMIN_PASSWORD);
  });
});

describe('sessions', () => {
  it('rejects requests without a session', async () => {
    expect((await new Client(base).get('/api/auth/me')).status).toBe(401);
  });

  it('ends the session on sign-out; the old cookie stops working', async () => {
    const c = new Client(base);
    await c.login('boss', ADMIN_PASSWORD);
    const oldCookie = c.cookie;
    expect((await c.post('/api/auth/logout')).status).toBe(200);
    const replay = new Client(base);
    replay.cookie = oldCookie;
    expect((await replay.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects an expired session', async () => {
    const c = new Client(base);
    await c.login('boss', ADMIN_PASSWORD);
    await db.query("UPDATE auth_sessions SET expires_at = now() - interval '1 minute'");
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('rejects a made-up cookie', async () => {
    const c = new Client(base);
    c.cookie = 'cvu_session=' + 'A'.repeat(43);
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });
});

describe('cross-site request protection', () => {
  it('refuses a state-changing call without the X-Requested-With header', async () => {
    const res = await new Client(base).post('/api/auth/login', { username: 'boss', password: ADMIN_PASSWORD }, { csrf: false });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('csrf_header_missing');
  });
});

describe('changing your password', () => {
  it('requires the current password, rejects weak ones, and ends your other sessions', async () => {
    const phone = new Client(base);
    const laptop = new Client(base);
    await phone.login('boss', ADMIN_PASSWORD);
    await laptop.login('boss', ADMIN_PASSWORD);

    expect((await laptop.post('/api/auth/change-password', { currentPassword: 'nope', newPassword: 'Another-long-pass-1' })).status).toBe(401);
    const weak = await laptop.post('/api/auth/change-password', { currentPassword: ADMIN_PASSWORD, newPassword: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.error).toBe('weak_password');
    const withName = await laptop.post('/api/auth/change-password', { currentPassword: ADMIN_PASSWORD, newPassword: 'my-name-is-boss-ok' });
    expect(withName.body.error).toBe('weak_password');

    const ok = await laptop.post('/api/auth/change-password', { currentPassword: ADMIN_PASSWORD, newPassword: 'Another-long-pass-1' });
    expect(ok.status).toBe(200);
    expect((await laptop.get('/api/auth/me')).status).toBe(200); // this session stays
    expect((await phone.get('/api/auth/me')).status).toBe(401); // the other one ended
    expect((await new Client(base).login('boss', 'Another-long-pass-1')).status).toBe(200);
  });
});
