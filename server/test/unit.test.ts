import { describe, expect, it } from 'vitest';
import { ownerScope } from '../src/access.js';
import { generateTemporaryPassword, hashPassword, passwordProblem, verifyPassword } from '../src/auth/password.js';
import type { AuthUser } from '../src/auth/sessions.js';

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
    expect(await verifyPassword('correct horse batterY', stored)).toBe(false);
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });

  it('salts every hash differently', async () => {
    expect(await hashPassword('same password here')).not.toBe(await hashPassword('same password here'));
  });

  it('explains what is wrong with a weak password', () => {
    expect(passwordProblem('short', 'priya')).toMatch(/at least 12/);
    expect(passwordProblem('i-am-priya-123', 'priya')).toMatch(/username/);
    expect(passwordProblem('aaaaaaaaaaaaaaaa', 'priya')).toMatch(/repetitive/);
    expect(passwordProblem('Long-enough-pass-9', 'priya')).toBeNull();
    expect(passwordProblem('Kk-admin-password-9', 'kk')).toBeNull(); // too short a name to check
  });

  it('generates readable one-time passwords', () => {
    const p = generateTemporaryPassword();
    expect(p).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
    expect(p).not.toMatch(/[0O1lI]/);
  });
});

describe('ownerScope', () => {
  const admin: AuthUser = { id: 'a', username: 'boss', displayName: 'B', role: 'admin', mustChangePassword: false };
  const consultant: AuthUser = { id: 'c-1', username: 'priya', displayName: 'P', role: 'consultant', mustChangePassword: false };

  it('lets an admin see every row', () => {
    expect(ownerScope(admin, 'r.uploaded_by')).toEqual({ sql: 'TRUE', params: [] });
  });

  it('limits a consultant to their own rows', () => {
    expect(ownerScope(consultant, 'r.uploaded_by', 3)).toEqual({ sql: 'r.uploaded_by = $3', params: ['c-1'] });
  });

  it('refuses anything that is not a plain column name', () => {
    expect(() => ownerScope(consultant, 'uploaded_by OR 1=1')).toThrow(/invalid column/);
  });
});
