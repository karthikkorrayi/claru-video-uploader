import { useState, type FormEvent } from 'react';
import type { PublicUser } from '@cvu/shared';
import { api, errorText } from '../api.js';

interface Props {
  user: PublicUser;
  forced?: boolean;
  onDone: (u: PublicUser) => void;
  onSignOut?: () => void;
}

export function ChangePasswordPage({ user, forced, onDone, onSignOut }: Props) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== repeat) {
      setError('The two new passwords do not match.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await api<{ user: PublicUser }>('POST', '/auth/change-password', { currentPassword: current, newPassword: next });
      onDone(r.user);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={forced ? 'center' : undefined}>
      <form className="card narrow" onSubmit={submit}>
        <h1>{forced ? 'Choose your password' : 'Change password'}</h1>
        {forced && (
          <p>
            Hello {user.displayName}. You signed in with a one-time password. Choose your own password to continue.
          </p>
        )}
        <label>
          {forced ? 'One-time password' : 'Current password'}
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </label>
        <label>
          New password
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
        </label>
        <label>
          New password again
          <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
        </label>
        <p className="muted small">At least 12 characters, not containing your username. Your other signed-in devices will be signed out.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button className="primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save password'}
          </button>
          {forced && onSignOut && (
            <button type="button" className="link" onClick={onSignOut}>
              Sign out
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
