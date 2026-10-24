import { useCallback, useEffect, useState } from 'react';
import type { PublicUser } from '@cvu/shared';
import { api, ApiError } from './api.js';
import { AuditPage } from './pages/Audit.js';
import { ChangePasswordPage } from './pages/ChangePassword.js';
import { DeclarePage } from './pages/Declare.js';
import { HomePage } from './pages/Home.js';
import { LoginPage } from './pages/Login.js';
import { RecordingsPage } from './pages/Recordings.js';
import { UploadPage } from './pages/Upload.js';
import { UsersPage } from './pages/Users.js';

type Page = 'home' | 'upload' | 'recordings' | 'declare' | 'users' | 'audit' | 'password';

export function App() {
  const [user, setUser] = useState<PublicUser | null | undefined>(undefined);
  const [page, setPage] = useState<Page>('home');
  const [uploadsDone, setUploadsDone] = useState(0);
  const countUpload = useCallback(() => setUploadsDone((n) => n + 1), []);
  const [declareIds, setDeclareIds] = useState<string[]>([]);
  const declare = useCallback((ids: string[]) => {
    setDeclareIds(ids);
    setPage('declare');
  }, []);

  const refresh = useCallback(() => {
    api<{ user: PublicUser }>('GET', '/auth/me')
      .then((r) => setUser(r.user))
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setUser(null);
        else setUser(null);
      });
  }, []);

  useEffect(refresh, [refresh]);

  async function signOut() {
    await api('POST', '/auth/logout').catch(() => undefined);
    setUser(null);
    setPage('home');
  }

  if (user === undefined) return <main className="center muted">Loading…</main>;
  if (user === null) return <LoginPage onSignedIn={(u) => { setUser(u); setPage('home'); }} />;
  if (user.mustChangePassword) {
    return <ChangePasswordPage user={user} forced onDone={(u) => setUser(u)} onSignOut={signOut} />;
  }

  const nav: Array<[Page, string]> = [
    ['home', 'Home'],
    ['upload', 'Upload'],
    ['recordings', 'Recordings'],
    ['declare', 'Declare'],
  ];
  if (user.role === 'admin') nav.push(['users', 'Users'], ['audit', 'Audit log']);
  nav.push(['password', 'Change password']);

  return (
    <>
      <header className="topbar">
        <strong>Claru Video Uploader</strong>
        <nav>
          {nav.map(([key, label]) => (
            <button key={key} className={page === key ? 'link active' : 'link'} onClick={() => setPage(key)}>
              {label}
            </button>
          ))}
        </nav>
        <span className="muted">
          {user.displayName} · {user.role}
        </span>
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </header>
      <main>
        {page === 'home' && <HomePage user={user} onGo={setPage} />}
        {/* Always mounted, only hidden: uploads keep running while you look at other pages. */}
        <div hidden={page !== 'upload'}>
          <UploadPage me={user} onUploaded={countUpload} />
        </div>
        {page === 'recordings' && <RecordingsPage me={user} refreshKey={uploadsDone} onDeclare={declare} />}
        {page === 'declare' && <DeclarePage initialIds={declareIds} onDone={() => setPage('recordings')} />}
        {page === 'users' && user.role === 'admin' && <UsersPage me={user} />}
        {page === 'audit' && user.role === 'admin' && <AuditPage />}
        {page === 'password' && <ChangePasswordPage user={user} onDone={(u) => { setUser(u); setPage('home'); }} />}
      </main>
    </>
  );
}
