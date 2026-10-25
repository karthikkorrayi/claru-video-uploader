import { useState, type FormEvent } from 'react';
import type { PublicUser } from '@cvu/shared';
import { Icon } from '../components/UI.js';
import { api, errorText } from '../api.js';

export function LoginPage({
  onSignedIn,
}: {
  onSignedIn: (u: PublicUser) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ user: PublicUser }>('POST', '/auth/login', {
        username,
        password,
      });
      onSignedIn(r.user);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center">
      <form className="card narrow" onSubmit={submit}>
        <div className="auth-brand">
          <span className="brand-mark">
            <Icon name="recordings" />
          </span>
          claru
        </div>
        <div>
          <p className="eyebrow">VIDEO WORKSPACE</p>
          <h1>Welcome back</h1>
          <p className="auth-intro">Sign in to manage your recordings.</p>
        </div>
        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
