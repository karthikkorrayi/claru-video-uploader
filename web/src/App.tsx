import { useCallback, useEffect, useRef, useState } from 'react';
import type { HealthReport, PublicUser } from '@cvu/shared';
import { api, ApiError } from './api.js';
import { AuditPage } from './pages/Audit.js';
import { ChangePasswordPage } from './pages/ChangePassword.js';
import { DeclarePage } from './pages/Declare.js';
import { HomePage } from './pages/Home.js';
import { LoginPage } from './pages/Login.js';
import { ProblemsPage } from './pages/Problems.js';
import { RecordingsPage } from './pages/Recordings.js';
import { UploadPage } from './pages/Upload.js';
import { UsersPage } from './pages/Users.js';

import { Icon, LoadingState, type IconName } from './components/UI.js';
import { useTheme } from './theme.js';

type Page =
  | 'home'
  | 'upload'
  | 'recordings'
  | 'declare'
  | 'users'
  | 'audit'
  | 'problems'
  | 'password';

const PAGE_INFO: Record<Page, { title: string; description: string }> = {
  home: {
    title: 'Overview',
    description: 'Your recording workspace, at a glance.',
  },
  upload: {
    title: 'Upload recordings',
    description:
      'Add footage with resumable uploads that keep your progress safe.',
  },
  recordings: {
    title: 'Recordings',
    description: 'Track uploads, review checks, and manage your footage.',
  },
  declare: {
    title: 'Declare recordings',
    description: 'Add capture details and confirm consent before delivery.',
  },
  users: {
    title: 'Users',
    description: 'Manage consultant access and account security.',
  },
  audit: {
    title: 'Audit log',
    description: 'Review sign-ins and account activity across your workspace.',
  },
  problems: {
    title: 'Problems',
    description: 'Investigate reported errors and background job failures.',
  },
  password: {
    title: 'Change password',
    description: 'Keep your account secure with a strong, unique password.',
  },
};

export function App() {
  const { theme, toggleTheme } = useTheme();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('cvu.sidebar') === 'collapsed';
    } catch {
      return false;
    }
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawer = useRef<HTMLDialogElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    try {
      localStorage.setItem('cvu.sidebar', collapsed ? 'collapsed' : 'expanded');
    } catch {
      /* Optional preference. */
    }
  }, [collapsed]);
  useEffect(() => {
    const dialog = drawer.current;
    if (drawerOpen && dialog && !dialog.open) dialog.showModal();
    if (!drawerOpen && dialog?.open) dialog.close();
    if (!drawerOpen) return;
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const desktop = window.matchMedia('(min-width: 901px)');
    const closeOnDesktop = () => {
      if (desktop.matches) setDrawerOpen(false);
    };
    desktop.addEventListener('change', closeOnDesktop);
    return () => {
      document.body.style.overflow = old;
      desktop.removeEventListener('change', closeOnDesktop);
    };
  }, [drawerOpen]);
  const [user, setUser] = useState<PublicUser | null | undefined>(undefined);
  const [page, setPage] = useState<Page>('home');
  useEffect(() => {
    document.title = `${PAGE_INFO[page].title} · Claru`;
    heading.current?.focus();
  }, [page]);
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

  // "Test server — mock Claru" etc., so nobody mistakes the test site for the real one.
  const [environment, setEnvironment] = useState('');
  useEffect(() => {
    fetch('/api/healthz')
      .then((r) => r.json() as Promise<HealthReport>)
      .then((h) => setEnvironment(h.environment ?? ''))
      .catch(() => undefined);
  }, []);
  const banner = environment ? (
    <div className="env-banner">{environment}</div>
  ) : null;

  async function signOut() {
    await api('POST', '/auth/logout').catch(() => undefined);
    setDrawerOpen(false);
    setUser(null);
    setPage('home');
  }

  const themeControl = (
    <button
      className="icon-button"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
    >
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  );
  if (user === undefined)
    return (
      <main className="center">
        <LoadingState label="Opening your workspace…" />
      </main>
    );
  if (user === null) {
    return (
      <>
        {banner}
        <div className="auth-tools">{themeControl}</div>
        <LoginPage
          onSignedIn={(u) => {
            setUser(u);
            setPage('home');
          }}
        />
      </>
    );
  }
  if (user.mustChangePassword) {
    return (
      <>
        {banner}
        <div className="auth-tools">{themeControl}</div>
        <ChangePasswordPage
          user={user}
          forced
          onDone={(u) => setUser(u)}
          onSignOut={signOut}
        />
      </>
    );
  }

  const nav: Array<[Page, string]> = [
    ['home', 'Home'],
    ['upload', 'Upload'],
    ['recordings', 'Recordings'],
    ['declare', 'Declare'],
  ];
  if (user.role === 'admin')
    nav.push(
      ['users', 'Users'],
      ['audit', 'Audit log'],
      ['problems', 'Problems'],
    );
  nav.push(['password', 'Change password']);

  function navigate(next: Page) {
    setPage(next);
    setDrawerOpen(false);
  }

  const navigation = (mobile = false) => (
    <>
      <div className="sidebar-brand">
        <span className="brand-mark">
          <Icon name="recordings" />
        </span>
        <span className="brand-copy">
          claru<span>VIDEO WORKSPACE</span>
        </span>
        {mobile && (
          <button
            className="icon-button drawer-close"
            onClick={() => setDrawerOpen(false)}
            aria-label="Close navigation"
          >
            <Icon name="close" />
          </button>
        )}
      </div>
      <div className="nav-caption">WORKSPACE</div>
      <nav aria-label={mobile ? 'Mobile navigation' : 'Main navigation'}>
        {nav.map(([key, label]) => (
          <button
            key={key}
            aria-label={label}
            className={`nav-item ${page === key ? 'active' : ''} ${key === 'users' ? 'admin-start' : ''}`}
            onClick={() => navigate(key)}
            aria-current={page === key ? 'page' : undefined}
            title={label}
          >
            <Icon name={key as IconName} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        <span className="avatar">
          {user.displayName.slice(0, 2).toUpperCase()}
        </span>
        <div className="sidebar-user">
          <strong>{user.displayName}</strong>
          <span>{user.role === 'admin' ? 'Administrator' : 'Consultant'}</span>
        </div>
        <button
          className="icon-button"
          onClick={signOut}
          aria-label="Sign out"
          title="Sign out"
        >
          <Icon name="logout" />
        </button>
      </div>
    </>
  );

  return (
    <>
      {banner}
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <div className={`app-layout ${collapsed ? 'sidebar-collapsed' : ''}`}>
        <aside className="sidebar">{navigation()}</aside>
        <dialog
          id="mobile-navigation"
          ref={drawer}
          className="mobile-drawer"
          aria-label="Navigation"
          onClose={() => {
            setDrawerOpen(false);
            menuButton.current?.focus();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setDrawerOpen(false);
          }}
        >
          <div className="drawer-inner">{navigation(true)}</div>
        </dialog>
        <div className="workspace">
          <header className="topbar">
            <button
              className="icon-button desktop-toggle"
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsed}
            >
              <Icon name="collapse" />
            </button>
            <button
              ref={menuButton}
              className="icon-button mobile-toggle"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open navigation"
              aria-expanded={drawerOpen}
              aria-controls="mobile-navigation"
            >
              <Icon name="menu" />
            </button>
            <div className="breadcrumb">
              <span>Workspace</span>
              <span aria-hidden="true">/</span>
              <strong>{PAGE_INFO[page].title}</strong>
            </div>
            <div className="topbar-actions">
              {themeControl}
              <span className="topbar-divider" />
              <button
                className="profile-button"
                onClick={() => navigate('password')}
                title="Change password"
              >
                <span className="avatar">
                  {user.displayName.slice(0, 2).toUpperCase()}
                </span>
                <span className="profile-copy">
                  <strong>{user.displayName}</strong>
                  <span>{user.role}</span>
                </span>
              </button>
              <button
                className="icon-button"
                onClick={signOut}
                aria-label="Sign out"
                title="Sign out"
              >
                <Icon name="logout" />
              </button>
            </div>
          </header>
          <main id="main-content" className="content" tabIndex={-1}>
            <div className="page-header">
              <div>
                <p className="eyebrow">YOUR WORKSPACE</p>
                <h1 ref={heading} tabIndex={-1}>
                  {PAGE_INFO[page].title}
                </h1>
                <p className="muted">{PAGE_INFO[page].description}</p>
              </div>
              {page !== 'upload' && (
                <button
                  className="primary header-upload"
                  onClick={() => navigate('upload')}
                >
                  <Icon name="upload" />
                  Upload recordings
                </button>
              )}
            </div>
            {page === 'home' && <HomePage user={user} onGo={setPage} />}
            {/* Always mounted, only hidden: uploads keep running while you look at other pages. */}
            <div hidden={page !== 'upload'}>
              <UploadPage theme={theme} me={user} onUploaded={countUpload} />
            </div>
            {page === 'recordings' && (
              <RecordingsPage
                me={user}
                refreshKey={uploadsDone}
                onDeclare={declare}
              />
            )}
            {page === 'declare' && (
              <DeclarePage
                initialIds={declareIds}
                onDone={() => setPage('recordings')}
              />
            )}
            {page === 'users' && user.role === 'admin' && (
              <UsersPage me={user} />
            )}
            {page === 'audit' && user.role === 'admin' && <AuditPage />}
            {page === 'problems' && user.role === 'admin' && <ProblemsPage />}
            {page === 'password' && (
              <ChangePasswordPage
                user={user}
                onDone={(u) => {
                  setUser(u);
                  setPage('home');
                }}
              />
            )}
          </main>
        </div>
      </div>
    </>
  );
}
