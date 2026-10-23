import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PublicUser, UserSummary } from '@cvu/shared';
import { api, errorText } from '../api.js';

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export function UsersPage({ me }: { me: PublicUser }) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{ username: string; password: string; what: string } | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');

  const load = useCallback(() => {
    api<{ users: UserSummary[] }>('GET', '/admin/users')
      .then((r) => setUsers(r.users))
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ user: PublicUser; temporaryPassword: string }>('POST', '/admin/users', { username, displayName });
      setNotice({ username: r.user.username, password: r.temporaryPassword, what: 'created' });
      setUsername('');
      setDisplayName('');
      load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function act(u: UserSummary, action: 'disable' | 'enable' | 'reset-password' | 'revoke-sessions') {
    const questions = {
      disable: `Disable ${u.username}? They are signed out at once and cannot sign in.`,
      enable: null,
      'reset-password': `Reset ${u.username}'s password? They are signed out and get a new one-time password.`,
      'revoke-sessions': `Sign ${u.username} out on every device?`,
    } as const;
    const q = questions[action];
    if (q && !window.confirm(q)) return;
    setError('');
    try {
      const r = await api<{ temporaryPassword?: string }>('POST', `/admin/users/${u.id}/${action}`);
      if (r.temporaryPassword) setNotice({ username: u.username, password: r.temporaryPassword, what: 'reset' });
      load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <>
      {notice && (
        <section className="card notice" role="status">
          <strong>
            One-time password for {notice.username} ({notice.what}):
          </strong>
          <code className="big">{notice.password}</code>
          <p className="small">
            Give it to {notice.username} in person or by phone. It is shown only now; they must choose their own password at first
            sign-in.
          </p>
          <button className="link" onClick={() => setNotice(null)}>
            I have noted it
          </button>
        </section>
      )}

      <section className="card">
        <h2>Add a consultant</h2>
        <form className="row wrap" onSubmit={create}>
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ravi.k" required />
          </label>
          <label>
            Display name
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ravi Kumar" required />
          </label>
          <button className="primary">Create</button>
        </form>
        <p className="muted small">Usernames: 2–32 lowercase letters, digits, dot, dash or underscore.</p>
      </section>

      {error && <p className="error" role="alert">{error}</p>}

      <section className="card">
        <h2>Users</h2>
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last sign-in</th>
              <th>Signed in on</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.displayName}
                  <div className="muted small">{u.username}</div>
                </td>
                <td>{u.role}</td>
                <td>{u.disabled ? 'disabled' : u.mustChangePassword ? 'must set password' : 'active'}</td>
                <td>{when(u.lastSignInAt)}</td>
                <td>
                  {u.activeSessions} device{u.activeSessions === 1 ? '' : 's'}
                </td>
                <td className="actions">
                  {u.role === 'consultant' && u.id !== me.id && (
                    <>
                      {u.disabled ? (
                        <button className="link" onClick={() => act(u, 'enable')}>Enable</button>
                      ) : (
                        <button className="link" onClick={() => act(u, 'disable')}>Disable</button>
                      )}
                      <button className="link" onClick={() => act(u, 'reset-password')}>Reset password</button>
                      {u.activeSessions > 0 && (
                        <button className="link" onClick={() => act(u, 'revoke-sessions')}>Sign out everywhere</button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
