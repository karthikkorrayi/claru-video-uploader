import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_PASSWORD, Client, createAdmin, resetDatabase, startApp, testPool } from './helpers.js';

const db = testPool();
let server: Server;
let base = '';
let admin: Client;
let adminId = '';

beforeAll(async () => {
  ({ server, base } = await startApp(db));
});
beforeEach(async () => {
  await resetDatabase(db);
  adminId = await createAdmin(db);
  admin = new Client(base);
  await admin.login('boss', ADMIN_PASSWORD);
});
afterAll(async () => {
  server.close();
  await db.end();
});

/** Creates a consultant and signs them in with a permanent password. */
async function consultant(username: string): Promise<{ client: Client; id: string; password: string }> {
  const created = await admin.post('/api/admin/users', { username, displayName: `Consultant ${username}` });
  expect(created.status).toBe(201);
  const client = new Client(base);
  await client.login(username, created.body.temporaryPassword);
  const password = `Permanent-pass-${username.length}-Xy7q`; // must not contain the username
  expect((await client.post('/api/auth/change-password', { currentPassword: created.body.temporaryPassword, newPassword: password })).status).toBe(200);
  return { client, id: created.body.user.id, password };
}

describe('creating consultants', () => {
  it('creates a consultant with a one-time password they must change', async () => {
    const res = await admin.post('/api/admin/users', { username: 'Ravi.K', displayName: 'Ravi Kumar' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ username: 'ravi.k', role: 'consultant', mustChangePassword: true });
    expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);

    const ravi = new Client(base);
    expect((await ravi.login('ravi.k', res.body.temporaryPassword)).body.user.mustChangePassword).toBe(true);
    // Until the password is changed, only /api/auth/* works.
    expect((await ravi.get('/api/admin/users')).body.error).toBe('password_change_required');
    expect((await ravi.get('/api/auth/me')).status).toBe(200);
  });

  it('refuses a duplicate username, case-insensitively', async () => {
    await admin.post('/api/admin/users', { username: 'priya', displayName: 'Priya' });
    const dup = await admin.post('/api/admin/users', { username: 'PRIYA', displayName: 'Another Priya' });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('username_taken');
  });

  it('refuses invalid usernames', async () => {
    for (const username of ['a', 'has space', 'émoji', '-starts-with-dash', 'x'.repeat(40)]) {
      expect((await admin.post('/api/admin/users', { username, displayName: 'X' })).status).toBe(400);
    }
  });

  it('never returns password hashes in the user list', async () => {
    await admin.post('/api/admin/users', { username: 'priya', displayName: 'Priya' });
    const list = await admin.get('/api/admin/users');
    expect(list.status).toBe(200);
    expect(list.body.users).toHaveLength(2);
    expect(JSON.stringify(list.body)).not.toMatch(/scrypt|password_hash|passwordHash/);
  });
});

describe('what a consultant cannot do', () => {
  it('cannot use any admin route', async () => {
    const { client } = await consultant('priya');
    const other = await consultant('ravi');
    const attempts = [
      client.get('/api/admin/users'),
      client.get('/api/admin/audit'),
      client.post('/api/admin/users', { username: 'sneaky', displayName: 'Sneaky' }),
      client.post(`/api/admin/users/${other.id}/disable`),
      client.post(`/api/admin/users/${other.id}/reset-password`),
      client.post(`/api/admin/users/${adminId}/disable`),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('admin_only');
    }
    expect((await db.query("SELECT 1 FROM users WHERE username = 'sneaky'")).rowCount).toBe(0);
  });
});

describe('managing consultants', () => {
  it('disabling signs the consultant out immediately and blocks new sign-ins', async () => {
    const priya = await consultant('priya');
    expect((await priya.client.get('/api/auth/me')).status).toBe(200);
    expect((await admin.post(`/api/admin/users/${priya.id}/disable`)).status).toBe(200);
    expect((await priya.client.get('/api/auth/me')).status).toBe(401);
    expect((await new Client(base).login('priya', priya.password)).status).toBe(401);

    expect((await admin.post(`/api/admin/users/${priya.id}/enable`)).status).toBe(200);
    expect((await new Client(base).login('priya', priya.password)).status).toBe(200);
  });

  it('resetting a password ends sessions and issues a new one-time password', async () => {
    const priya = await consultant('priya');
    const reset = await admin.post(`/api/admin/users/${priya.id}/reset-password`);
    expect(reset.status).toBe(200);
    expect((await priya.client.get('/api/auth/me')).status).toBe(401);
    expect((await new Client(base).login('priya', priya.password)).status).toBe(401);
    const again = new Client(base);
    expect((await again.login('priya', reset.body.temporaryPassword)).body.user.mustChangePassword).toBe(true);
  });

  it('can end all of a consultant’s sessions', async () => {
    const priya = await consultant('priya');
    const res = await admin.post(`/api/admin/users/${priya.id}/revoke-sessions`);
    expect(res.body.sessionsEnded).toBe(1);
    expect((await priya.client.get('/api/auth/me')).status).toBe(401);
  });

  it('does not manage admin accounts through the API', async () => {
    expect((await admin.post(`/api/admin/users/${adminId}/disable`)).body.error).toBe('cannot_modify_admin');
  });

  it('answers 404 for unknown or malformed ids', async () => {
    expect((await admin.post('/api/admin/users/00000000-0000-0000-0000-000000000000/disable')).status).toBe(404);
    expect((await admin.post('/api/admin/users/not-a-uuid/disable')).status).toBe(404);
  });

  it('records every admin action in the audit log', async () => {
    const priya = await consultant('priya');
    await admin.post(`/api/admin/users/${priya.id}/disable`);
    const audit = await admin.get('/api/admin/audit?limit=50');
    const actions = (audit.body.entries as Array<{ action: string; actor: string | null }>).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['user_created', 'user_disabled', 'password_changed', 'login_succeeded']));
    expect(JSON.stringify(audit.body)).not.toMatch(/Permanent-pass|scrypt/);
  });
});
