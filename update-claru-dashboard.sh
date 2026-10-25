#!/usr/bin/env bash
# Complete Claru dashboard update: all source files are embedded below.
# Usage: bash update-claru-dashboard.sh [/path/to/claru-video-uploader] [--apply-only]
# Default: back up, apply, install dependencies if missing, then validate.
# --apply-only: back up and apply without running npm commands.
# No commits, resets, deletions, or backend changes are performed.
set -euo pipefail
apply_only=0
repo_arg=""
for arg in "$@"; do
  case "$arg" in
    --apply-only) apply_only=1 ;;
    -h|--help)
      printf 'Usage: bash %s [/path/to/claru-video-uploader] [--apply-only]\n' "$0"
      exit 0 ;;
    --*) printf 'Unknown option: %s\n' "$arg" >&2; exit 2 ;;
    *) if [[ -n "$repo_arg" ]]; then printf 'Provide only one repository path.\n' >&2; exit 2; fi; repo_arg="$arg" ;;
  esac
done
command -v python3 >/dev/null || { printf 'Python 3 is required.\n' >&2; exit 1; }
command -v git >/dev/null || { printf 'Git is required.\n' >&2; exit 1; }
if [[ -z "$repo_arg" ]]; then
  repo_arg="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    printf 'Run inside the project, or pass its path as the first argument.\n' >&2; exit 1;
  }
fi
repo_dir="$(cd -- "$repo_arg" && pwd -P)"
python3 - "$repo_dir" <<'CLARU_COMPLETE_FRONTEND_PAYLOAD'
from pathlib import Path
import hashlib, json, os, shutil, stat, sys, tempfile

root = Path(sys.argv[1]).resolve()
manifest = root / 'package.json'
if not manifest.is_file() or json.loads(manifest.read_text()).get('name') != 'claru-video-uploader':
    raise SystemExit('This directory is not the Claru Video Uploader repository.')
# Original SHA-256 hashes prevent overwriting unrelated or customized source.
ORIGINAL_HASHES = {'web/src/App.tsx': 'c4c3740bda3dea13b8bab7c6b7f009ab0a91918d45ecf7d443f94e9054d843fa', 'web/src/styles.css': 'c0ee3e4de284b751f5b487bc8d8f8a8767fd2ab9c874d90a039bfd053abf917a', 'web/src/theme.ts': None, 'web/src/components/UI.tsx': None, 'web/src/pages/Audit.tsx': 'ba1704525cc9ef084a32a7715bcc5db94cd337acc744b87b014a9b4bd0a8df26', 'web/src/pages/ChangePassword.tsx': 'c51efa9653ace9f0c7c671f303ba9ea1212d0b4887364ad0ade765d9eb2b5d3a', 'web/src/pages/Declare.tsx': '349d31fd84033ddc1080c59a5dda1793d9506580ef97f1afbb52aec8ee7717ca', 'web/src/pages/Home.tsx': 'b2a7ce2faeb5bfc49715351fcad851cf52cb5e60c3ffef89b32afd31a01dcbec', 'web/src/pages/Login.tsx': '00c6ec1f36483850fffb8011c3d23787055f2e701424fba92777ae14cc9a9e38', 'web/src/pages/Problems.tsx': 'c4e915ff3eea86bed9876654d38a6abf8b81842d51c60f4d4afcf032e6266a57', 'web/src/pages/Recordings.tsx': '41e208cf02acca430f661e9e174d4e0ed7b3600c62e131202f533abe2c2a610a', 'web/src/pages/Upload.tsx': '2ccf19e4748f8cb129335d71151eee8617b3cb6517596423d5c7ff05d4be7349', 'web/src/pages/Users.tsx': '1014a478940f0f4a5fa5580eb0c8422716e5ddf693a6413e81d93e598bbdf3d0', 'scripts/frontend.sh': None, 'docs/FRONTEND.md': None}

FILES = {
    'web/src/App.tsx': r"""import { useCallback, useEffect, useRef, useState } from 'react';
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
""",
    'web/src/styles.css': r""":root {
  font-family:
    'Inter',
    -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    sans-serif;
  font-synthesis: none;
  -webkit-font-smoothing: antialiased;
  --bg: #f5f6fa;
  --panel: #fff;
  --surface: #f8f9fc;
  --text: #20293b;
  --muted: #647087;
  --line: #e5e8f0;
  --accent: #4f46d5;
  --accent-hover: #4038b8;
  --accent-soft: #eeedff;
  --on-accent: #fff;
  --ok: #167249;
  --ok-bg: #e9f7f0;
  --bad: #ba3442;
  --bad-bg: #fff0f1;
  --notice: #fff8e8;
  --shadow: 0 3px 14px #17233d04;
  --sidebar: #121b2e;
  --sidebar-text: #aab6cc;
  color: var(--text);
  background: var(--bg);
  color-scheme: light;
}
:root[data-theme='dark'] {
  --bg: #111724;
  --panel: #1a2233;
  --surface: #202a3d;
  --text: #edf1fa;
  --muted: #a6b2c9;
  --line: #303c52;
  --accent: #aaa4ff;
  --accent-hover: #c0bbff;
  --accent-soft: #302e50;
  --on-accent: #17132f;
  --ok: #77dcac;
  --ok-bg: #1b3a31;
  --bad: #ff9aaa;
  --bad-bg: #452a38;
  --notice: #38301f;
  --shadow: 0 3px 14px #00000010;
  color-scheme: dark;
}
* {
  box-sizing: border-box;
}
[hidden] {
  display: none !important;
}
body {
  margin: 0;
  font-size: 14px;
  line-height: 1.55;
}
button,
input,
select {
  font: inherit;
}
button {
  cursor: pointer;
}
button,
a,
input,
select,
summary {
  -webkit-tap-highlight-color: transparent;
}
button {
  transition:
    background 0.15s,
    color 0.15s,
    border-color 0.15s;
}
button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 3px;
}
h1:focus,
main:focus {
  outline: none;
}
h1,
h2,
h3,
p {
  margin-top: 0;
}
h1 {
  font-size: clamp(1.65rem, 3vw, 2rem);
  line-height: 1.2;
  letter-spacing: -0.045em;
  margin-bottom: 8px;
  font-weight: 700;
}
h2 {
  font-size: 1.05rem;
  letter-spacing: -0.02em;
  margin-bottom: 8px;
}
h3 {
  font-size: 0.9rem;
  margin-bottom: 8px;
}
p {
  margin-bottom: 16px;
}
.icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  vertical-align: middle;
}
.icon-button {
  width: 38px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: 9px;
  color: var(--muted);
  background: transparent;
  flex-shrink: 0;
}
.icon-button:hover {
  color: var(--text);
  background: var(--surface);
  border-color: var(--line);
}
.app-layout {
  display: grid;
  grid-template-columns: 238px minmax(0, 1fr);
  min-height: 100dvh;
  transition: grid-template-columns 0.2s;
}
.sidebar {
  background: var(--sidebar);
  color: var(--sidebar-text);
  position: sticky;
  top: 0;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  padding: 26px 16px 16px;
  overflow-y: auto;
}
.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 0 10px;
  min-height: 44px;
  margin-bottom: 42px;
  color: #fff;
}
.brand-mark {
  width: 34px;
  height: 36px;
  display: grid;
  place-items: center;
  background: #7367ef;
  border-radius: 10px;
  flex-shrink: 0;
}
.brand-copy {
  font-size: 25px;
  font-weight: 750;
  letter-spacing: -0.05em;
  line-height: 1;
}
.brand-copy > span {
  display: block;
  font-size: 8px;
  letter-spacing: 0.17em;
  color: #aab6cc;
  margin-top: 9px;
  font-weight: 500;
  white-space: nowrap;
}
.nav-caption {
  font-size: 10px;
  letter-spacing: 0.15em;
  font-weight: 650;
  padding: 0 14px;
  margin-bottom: 12px;
}
.sidebar nav,
.drawer-inner nav {
  display: grid;
  gap: 5px;
}
.nav-item {
  border: 0;
  padding: 11px 14px;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  display: flex;
  gap: 12px;
  align-items: center;
  text-align: left;
  width: 100%;
  font-weight: 500;
  white-space: nowrap;
}
.nav-item:hover {
  background: #ffffff0c;
  color: #fff;
}
.nav-item.active {
  color: #fff;
  background: #6555d9;
  box-shadow: 0 4px 12px #0002;
}
.nav-item.admin-start {
  margin-top: 22px;
}
.sidebar-footer {
  margin-top: auto;
  padding: 22px 4px 0;
  display: flex;
  align-items: center;
  gap: 10px;
  border-top: 1px solid #ffffff13;
}
.sidebar nav {
  margin-bottom: 32px;
}
.avatar {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}
.sidebar .avatar,
.mobile-drawer .avatar {
  color: #d5d0ff;
  background: #30324e;
}
.sidebar-user {
  min-width: 0;
  flex: 1;
}
.sidebar-user strong,
.sidebar-user span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sidebar-user strong {
  font-size: 12px;
  color: #edf1fa;
}
.sidebar-user span {
  font-size: 11px;
}
.sidebar-footer .icon-button,
.drawer-close {
  color: #aab6cc;
}
.sidebar-footer .icon-button:hover,
.drawer-close:hover {
  color: #fff;
  background: #ffffff13;
  border-color: transparent;
}
.workspace {
  min-width: 0;
}
.topbar {
  min-height: 72px;
  background: var(--panel);
  border-bottom: 1px solid var(--line);
  padding: 12px 30px;
  display: flex;
  align-items: center;
  gap: 16px;
}
.breadcrumb {
  display: flex;
  gap: 12px;
  align-items: center;
  font-size: 12px;
  color: var(--muted);
}
.breadcrumb strong {
  color: var(--text);
  font-weight: 550;
}
.topbar-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
}
.topbar-divider {
  width: 1px;
  height: 28px;
  background: var(--line);
  margin: 0 6px;
}
.profile-button {
  display: flex;
  gap: 10px;
  align-items: center;
  color: var(--text);
  background: none;
  border: 0;
  border-radius: 8px;
  padding: 3px;
  text-align: left;
}
.profile-button:hover {
  background: var(--surface);
}
.profile-copy {
  max-width: 170px;
}
.profile-copy strong,
.profile-copy > span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.profile-copy strong {
  font-size: 12px;
  font-weight: 600;
}
.profile-copy > span {
  color: var(--muted);
  font-size: 10px;
  text-transform: capitalize;
}
.content {
  max-width: 1480px;
  padding: 32px clamp(20px, 3vw, 44px) 60px;
  margin: 0 auto;
}
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 28px;
}
.page-header p {
  margin-bottom: 0;
}
.eyebrow {
  color: var(--muted);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.15em;
  margin-bottom: 10px !important;
}
.card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 13px;
  padding: 24px;
  margin: 0 0 20px;
  box-shadow: var(--shadow);
  min-width: 0;
}
.card > :last-child {
  margin-bottom: 0;
}
.card.narrow {
  width: min(440px, 100%);
  padding: 34px;
  display: grid;
  gap: 18px;
}
.card.narrow h1 {
  font-size: 1.5rem;
  margin: 0;
}
.card.narrow p {
  margin-bottom: 0;
}
.notice {
  background: var(--notice);
}
label {
  display: grid;
  gap: 7px;
  font-size: 12px;
  font-weight: 550;
}
input,
select {
  width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  color: var(--text);
  box-shadow: 0 1px 2px #00000003;
}
input:hover,
select:hover {
  border-color: var(--muted);
}
input::placeholder {
  color: var(--muted);
  opacity: 0.8;
}
input[type='checkbox'] {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  accent-color: var(--accent);
  margin: 0;
}
button.primary {
  min-height: 39px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 10px 16px;
  border-radius: 8px;
  border: 1px solid transparent;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 12px;
  font-weight: 600;
  box-shadow: 0 2px 3px #0000000b;
}
button.primary:hover:not(:disabled) {
  background: var(--accent-hover);
}
button.primary .icon {
  width: 16px;
  height: 16px;
}
button.link {
  border: 0;
  background: none;
  color: var(--accent);
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 550;
}
button.link:hover:not(:disabled) {
  background: var(--accent-soft);
}
button.link .icon {
  width: 15px;
  height: 15px;
  margin-left: 4px;
}
button.link.danger {
  color: var(--bad);
}
.row {
  display: flex;
  gap: 12px;
  align-items: end;
}
.row.wrap {
  flex-wrap: wrap;
}
.row.spread,
.section-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
}
.section-heading {
  margin-bottom: 20px;
}
.section-heading h2,
.section-heading p {
  margin-bottom: 2px;
}
.table-scroll {
  overflow-x: auto;
  max-width: 100%;
  border: 1px solid var(--line);
  border-radius: 9px;
  margin-top: 18px;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
th,
td {
  text-align: left;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
  vertical-align: top;
}
th {
  color: var(--muted);
  font-weight: 600;
  font-size: 10px;
  background: var(--surface);
  text-transform: uppercase;
  letter-spacing: 0.055em;
  white-space: nowrap;
}
tbody tr:last-child > td {
  border-bottom: 0;
}
tbody tr:hover > td {
  background: color-mix(in srgb, var(--accent) 3%, var(--panel));
}
td:first-child {
  max-width: 320px;
  overflow-wrap: anywhere;
}
.actions {
  min-width: 100px;
}
.actions button {
  text-align: left;
}
.muted {
  color: var(--muted);
}
.small {
  font-size: 12px;
}
.mono,
code {
  font-family: ui-monospace, Menlo, monospace;
  overflow-wrap: anywhere;
}
code.big {
  display: block;
  font-size: 1.4rem;
  margin: 8px 0;
  letter-spacing: 0.05em;
}
.nowrap {
  white-space: nowrap;
}
.ok {
  color: var(--ok);
}
.error {
  color: var(--bad);
}
p.error {
  padding: 12px 16px;
  border: 1px solid color-mix(in srgb, var(--bad) 25%, var(--line));
  border-radius: 8px;
  background: var(--bad-bg);
  overflow-wrap: anywhere;
}
.badge {
  display: inline-block;
  padding: 4px 9px;
  border-radius: 6px;
  background: var(--surface);
  color: var(--muted);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.5;
}
.badge.ok {
  color: var(--ok);
  background: var(--ok-bg);
}
.badge.error {
  color: var(--bad);
  background: var(--bad-bg);
}
.notice-inline {
  background: var(--notice);
  padding: 10px 14px;
  border-radius: 8px;
}
progress {
  display: inline-block;
  max-width: 100%;
  width: 110px;
  height: 6px;
  vertical-align: middle;
  accent-color: var(--accent);
}
details {
  border: 1px solid var(--line);
  padding: 12px 14px;
  border-radius: 8px;
  background: var(--surface);
}
summary {
  cursor: pointer;
  font-weight: 550;
}
details ul {
  margin: 10px 0 0;
  padding-left: 20px;
}
tr.detail > td {
  background: var(--surface);
}
.details {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));
  gap: 20px;
  padding: 10px 2px;
}
.details > .row {
  grid-column: 1 / -1;
}
.details ul,
.details ol {
  margin: 4px 0;
  padding-left: 18px;
}
.problems li {
  margin: 2px 0;
}
dl.kv {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 5px 12px;
  margin: 0 0 10px;
}
dl.kv dt {
  color: var(--muted);
}
dl.kv dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.grid2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr));
  gap: 20px;
}
.declare-row {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 18px;
  margin-top: 12px;
  overflow-wrap: anywhere;
}
.declare-row.on {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--line));
  background: color-mix(in srgb, var(--accent) 3%, var(--panel));
}
.declare-fields {
  padding: 20px 0 0 26px;
  display: grid;
  gap: 18px;
}
label.inline {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  font-weight: 400;
}
label.consent {
  flex-wrap: nowrap;
  align-items: flex-start;
  padding: 6px 0;
}
label.consent input {
  margin-top: 3px;
}
label.consent code {
  font-size: 10px;
}
fieldset.consents {
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px 16px;
  display: grid;
  gap: 8px;
  margin: 0;
}
.env-banner {
  background: #9a4b0b;
  color: #fff;
  text-align: center;
  font-size: 12px;
  padding: 5px 12px;
  font-weight: 600;
}
tr.clickable {
  cursor: pointer;
}
pre.detail-json {
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--surface);
  padding: 12px;
  border-radius: 6px;
  margin: 10px 0 0;
}
.empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  text-align: center;
  min-height: 200px;
  padding: 32px 20px;
}
.empty-state p {
  max-width: 330px;
  margin-bottom: 0;
}
.empty-icon {
  width: 52px;
  height: 52px;
  background: var(--accent-soft);
  color: var(--accent);
  display: grid;
  place-items: center;
  border-radius: 14px;
  margin-bottom: 16px;
}
.loading-state {
  min-height: 150px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--muted);
  font-size: 12px;
}
.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--line);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.welcome-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 30px;
  background: linear-gradient(110deg, var(--panel), var(--accent-soft));
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 30px 34px;
  margin-bottom: 22px;
  overflow: hidden;
}
.welcome-card h2 {
  font-size: clamp(1.35rem, 2.5vw, 1.7rem);
  margin: 8px 0 12px;
  letter-spacing: -0.04em;
}
.welcome-card p {
  color: var(--muted);
  max-width: 460px;
  font-size: 13px;
}
.welcome-card .eyebrow {
  color: var(--accent);
}
.welcome-art {
  width: 180px;
  height: 150px;
  flex-shrink: 0;
  position: relative;
  display: grid;
  place-items: center;
}
.art-orbit {
  position: absolute;
  width: 156px;
  height: 156px;
  border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent);
  border-radius: 50%;
}
.art-file {
  display: grid;
  place-items: center;
  width: 85px;
  height: 105px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 15px;
  transform: rotate(-9deg);
  color: var(--accent);
  box-shadow: 0 12px 30px #4f46d51a;
  padding: 16px;
}
.art-file .icon {
  width: 34px;
  height: 34px;
}
.art-file span {
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.12em;
}
.art-check {
  position: absolute;
  bottom: 16px;
  right: 27px;
  background: var(--ok-bg);
  color: var(--ok);
  width: 37px;
  height: 37px;
  display: grid;
  place-items: center;
  border: 4px solid var(--panel);
  border-radius: 50%;
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
}
.stat-card {
  padding: 20px 24px;
}
.stat-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  color: var(--muted);
  font-size: 12px;
}
.stat-icon {
  color: var(--accent);
  background: var(--accent-soft);
  padding: 7px;
  border-radius: 8px;
}
.stat-icon .icon {
  width: 17px;
  height: 17px;
}
.stat-value {
  display: block;
  font-size: 30px;
  letter-spacing: -0.05em;
  line-height: 1.3;
  margin: 7px 0;
}
.stat-card p {
  font-size: 10px;
}
.overview-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(260px, 1fr);
  gap: 20px;
}
.recent-list,
.workflow-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.recent-list li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px 0;
  border-top: 1px solid var(--line);
}
.file-icon {
  color: var(--accent);
  background: var(--accent-soft);
  padding: 9px;
  border-radius: 9px;
}
.recent-list li > div {
  flex: 1;
  min-width: 0;
}
.recent-list strong {
  display: block;
  font-size: 12px;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.recent-list .small {
  font-size: 10px;
}
.workflow-list {
  margin-top: 24px;
}
.workflow-list li {
  display: flex;
  gap: 12px;
  margin-bottom: 22px;
}
.workflow-list li > span {
  width: 25px;
  height: 25px;
  border: 1px solid var(--line);
  background: var(--surface);
  border-radius: 50%;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  color: var(--accent);
  font-size: 10px;
  font-weight: 650;
}
.workflow-list strong {
  font-size: 12px;
  font-weight: 550;
}
.workflow-list p {
  font-size: 11px;
  color: var(--muted);
  margin: 3px 0 0;
}
.service-status {
  border-top: 1px solid var(--line);
  padding-top: 15px;
  font-size: 10px;
  display: flex;
  gap: 8px;
  align-items: center;
  color: var(--muted);
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--muted);
  flex-shrink: 0;
}
.status-dot.healthy {
  background: var(--ok);
}
.status-dot.unhealthy {
  background: var(--bad);
}
main.center {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  background: radial-gradient(
    ellipse at 20% 20%,
    var(--accent-soft),
    transparent 55%
  );
}
.auth-tools {
  position: absolute;
  top: 20px;
  right: 20px;
}
.auth-brand {
  display: flex;
  gap: 10px;
  align-items: center;
  color: var(--text);
  font-size: 24px;
  font-weight: 750;
  letter-spacing: -0.05em;
}
.auth-intro {
  color: var(--muted);
  font-size: 13px;
}
.password-panel {
  padding: 0;
  margin: 0;
  max-width: none;
}
.password-panel .narrow {
  width: min(520px, 100%);
}
.skip-link {
  position: fixed;
  top: -70px;
  left: 20px;
  z-index: 100;
  background: var(--accent);
  color: var(--on-accent);
  border-radius: 8px;
  padding: 12px 18px;
}
.skip-link:focus {
  top: 15px;
}
.sidebar-collapsed {
  grid-template-columns: 80px minmax(0, 1fr);
}
.sidebar-collapsed .sidebar {
  padding: 26px 12px 16px;
}
.sidebar-collapsed .sidebar-brand {
  padding: 0;
  justify-content: center;
}
.sidebar-collapsed .brand-copy,
.sidebar-collapsed .nav-item span,
.sidebar-collapsed .nav-caption,
.sidebar-collapsed .sidebar-user,
.sidebar-collapsed .sidebar-footer > .avatar {
  display: none;
}
.sidebar-collapsed .nav-item {
  justify-content: center;
  padding: 13px;
}
.sidebar-collapsed .sidebar-footer {
  justify-content: center;
}
.mobile-drawer {
  border: 0;
  padding: 0;
  margin: 0;
  width: min(300px, 88vw);
  max-width: 88vw;
  height: 100dvh;
  max-height: 100dvh;
  background: var(--sidebar);
  color: var(--sidebar-text);
}
.mobile-drawer::backdrop {
  background: #080f20a6;
  backdrop-filter: blur(3px);
}
.drawer-inner {
  padding: 24px 16px 20px;
  min-height: 100%;
  display: flex;
  flex-direction: column;
}
.drawer-close {
  margin-left: auto;
}
.mobile-toggle {
  display: none;
}
/* Uppy follows the selected application theme without recreating its upload instance. */
.uppy-Dashboard-inner {
  border-color: var(--line) !important;
  border-radius: 13px !important;
}
.uppy-Dashboard {
  margin-bottom: 20px;
}
@media (max-width: 1150px) {
  .overview-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .workflow-list {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
  }
  .stats-grid {
    gap: 14px;
  }
  .stat-card {
    padding: 18px;
  }
}
@media (max-width: 900px) {
  .app-layout,
  .sidebar-collapsed {
    grid-template-columns: minmax(0, 1fr);
  }
  .sidebar {
    display: none;
  }
  .desktop-toggle {
    display: none;
  }
  .mobile-toggle {
    display: inline-flex;
  }
  .topbar {
    padding: 12px 20px;
  }
  .content {
    padding: 26px 24px 50px;
  }
}
@media (max-width: 600px) {
  .topbar {
    padding: 10px 14px;
    gap: 8px;
    min-height: 64px;
  }
  .breadcrumb > span,
  .profile-copy,
  .topbar-divider {
    display: none;
  }
  .breadcrumb {
    font-size: 11px;
  }
  .topbar-actions {
    gap: 2px;
  }
  .profile-button .avatar {
    width: 30px;
    height: 30px;
  }
  .icon-button {
    width: 34px;
    height: 36px;
  }
  .content {
    padding: 24px 16px 40px;
  }
  .page-header {
    margin-bottom: 22px;
    align-items: flex-start;
    flex-direction: column;
    gap: 14px;
  }
  .page-header .muted {
    font-size: 12px;
  }
  .card {
    padding: 18px;
    border-radius: 11px;
  }
  .card.narrow {
    padding: 26px;
  }
  .welcome-card {
    padding: 24px;
  }
  .welcome-art {
    display: none;
  }
  .stats-grid {
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
  }
  .stat-card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0 12px;
    margin-bottom: 12px;
  }
  .stat-top {
    grid-column: 1;
    flex-direction: row-reverse;
    justify-content: flex-end;
  }
  .stat-value {
    grid-column: 2;
    grid-row: 1 / 3;
    align-self: center;
    margin: 0;
  }
  .stat-card p {
    grid-column: 1;
    margin: 4px 0 0 44px;
  }
  .overview-grid {
    margin-top: 8px;
  }
  .workflow-list {
    display: block;
  }
  .row {
    flex-wrap: wrap;
  }
  .row.wrap > label {
    flex: 1 1 160px;
  }
  .declare-fields {
    padding-left: 0;
  }
  .declare-row {
    padding: 14px;
  }
  .declare-row > label.inline {
    align-items: flex-start;
  }
  th,
  td {
    padding: 12px;
  }
  .table-scroll table {
    min-width: 680px;
  }
  .recent-list .badge {
    max-width: 82px;
  }
}
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
.auth-password.center {
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  background: radial-gradient(
    ellipse at 20% 20%,
    var(--accent-soft),
    transparent 55%
  );
}
.problem-toggle {
  text-align: left;
  overflow-wrap: anywhere;
}
""",
    'web/src/theme.ts': r"""import { useLayoutEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem('cvu.theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch {
      /* Storage can be unavailable in private browsing. */
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  });
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('cvu.theme', theme);
    } catch {
      /* Theme still works without storage. */
    }
  }, [theme]);
  return {
    theme,
    toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
  };
}
""",
    'web/src/components/UI.tsx': r"""import type { ReactNode } from 'react';

const paths = {
  home: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 15v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5',
  recordings: 'M4 4h16v16H4zM9 4v16M4 9h5M4 15h5m4-6 5 3-5 3Z',
  declare: 'M9 3H5v18h14V3h-4M9 2h6v4H9zm-1 11 3 3 5-6',
  users:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8m8 .13a4 4 0 0 1 0 7.75',
  audit: 'M9 5h12M9 12h12M9 19h12M3 5h1M3 12h1M3 19h1',
  problems: 'm12 3 10 18H2ZM12 9v4m0 4v.01',
  password: 'M5 10h14v11H5zm3 0V6a4 4 0 0 1 8 0v4m-4 4v3',
  menu: 'M4 6h16M4 12h16M4 18h16',
  close: 'm6 6 12 12M6 18 18 6',
  collapse: 'M4 4h16v16H4zM9 4v16m7-12-4 4 4 4',
  moon: 'M21 12.8A9 9 0 0 1 11.2 3 9 9 0 1 0 21 12.8Z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m0-6v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
  logout: 'M9 3H4v18h5m5-14 5 5-5 5m-6-5h13',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  check: 'm5 12 4 4L19 6',
} satisfies Record<string, string>;

export type IconName = keyof typeof paths;
export function Icon({
  name,
  className = '',
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading-state" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  icon = 'recordings',
}: {
  title: string;
  children?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} />
      </span>
      <h3>{title}</h3>
      {children && <p className="muted small">{children}</p>}
    </div>
  );
}
""",
    'web/src/pages/Audit.tsx': r"""import { EmptyState, LoadingState } from '../components/UI.js';
import { useEffect, useState } from 'react';
import type { AuditView } from '@cvu/shared';
import { api, errorText } from '../api.js';

export function AuditPage() {
  const [entries, setEntries] = useState<AuditView[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ entries: AuditView[] }>('GET', '/admin/audit?limit=200')
      .then((r) => setEntries(r.entries))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <section className="card">
      <h2>Audit log</h2>
      <p className="muted small">
        Sign-ins, failures and account changes, newest first. Passwords are
        never recorded.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <LoadingState label="Loading audit…" />
      ) : !error && entries.length === 0 ? (
        <EmptyState title="No activity yet" />
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-label="Audit table"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>Details</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{new Date(e.at).toLocaleString()}</td>
                  <td>{e.actor ?? '—'}</td>
                  <td>{e.action.replace(/_/g, ' ')}</td>
                  <td className="small mono">
                    {Object.keys(e.details).length
                      ? JSON.stringify(e.details)
                      : ''}
                  </td>
                  <td className="small">{e.ip ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
""",
    'web/src/pages/ChangePassword.tsx': r"""import { useState, type FormEvent } from 'react';
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
      const r = await api<{ user: PublicUser }>(
        'POST',
        '/auth/change-password',
        { currentPassword: current, newPassword: next },
      );
      onDone(r.user);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={forced ? 'center auth-password' : 'password-panel'}>
      <form className="card narrow" onSubmit={submit}>
        {forced ? <h1>Choose your password</h1> : <h2>Update your password</h2>}
        {forced && (
          <p>
            Hello {user.displayName}. You signed in with a one-time password.
            Choose your own password to continue.
          </p>
        )}
        <label>
          {forced ? 'One-time password' : 'Current password'}
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          New password
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <label>
          New password again
          <input
            type="password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>
        <p className="muted small">
          At least 12 characters, not containing your username. Your other
          signed-in devices will be signed out.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
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
    </div>
  );
}
""",
    'web/src/pages/Declare.tsx': r"""import { EmptyState, LoadingState } from '../components/UI.js';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CONSENT_KEYS,
  CONSENT_TEXT,
  type ClaruProjectView,
  type ConsentAnswers,
  type ConsentKey,
  type RecordingView,
  type SharedDeclaration,
} from '@cvu/shared';
import { api, errorText } from '../api.js';
import { checkLabel, minutes } from './Recordings.js';

interface Row {
  date: string;
  time: string;
  consent: Record<ConsentKey, boolean>;
}

const NONE: Record<ConsentKey, boolean> = {
  worker_consent_obtained: false,
  site_or_employer_permission_obtained: false,
  required_consent_or_notice_process_followed: false,
  footage_unedited: false,
};

const LAST_SHARED = 'cvu.lastShared';
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function loadLastShared(): SharedDeclaration {
  const empty = {
    categoryCode: '',
    country: 'IN',
    siteId: '',
    device: '',
    mount: '',
  };
  try {
    return {
      ...empty,
      ...(JSON.parse(
        localStorage.getItem(LAST_SHARED) ?? '{}',
      ) as Partial<SharedDeclaration>),
    };
  } catch {
    return empty;
  }
}

function localParts(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/**
 * Claru's declaration for each clip (claru-integration.md, "What you declare
 * with each clip"). Shared fields once for the batch; the capture time and the
 * four consents per recording, never pre-ticked. collectorId is the uploader.
 */
export function DeclarePage({
  initialIds,
  onDone,
}: {
  initialIds: string[];
  onDone: () => void;
}) {
  const [project, setProject] = useState<ClaruProjectView | null>(null);
  const [recordings, setRecordings] = useState<RecordingView[]>([]);
  const [selected, setSelected] = useState<string[]>(initialIds);
  const [shared, setShared] = useState<SharedDeclaration>(loadLastShared);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<{ project: ClaruProjectView }>('GET', '/claru/project')
      .then((r) => setProject(r.project))
      .catch((e: unknown) =>
        setError(`Category list unavailable: ${errorText(e)}`),
      );
    api<{ recordings: RecordingView[] }>('GET', '/recordings?status=received')
      .then((r) => {
        const usable = r.recordings.filter((x) => x.checkStatus !== 'failed');
        setRecordings(usable);
        const next: Record<string, Row> = {};
        for (const x of usable) {
          // Keep the capture time already declared; consents are always ticked afresh.
          const p = x.declaration
            ? localParts(x.declaration.recordedAt)
            : { date: '', time: '' };
          next[x.id] = { ...p, consent: { ...NONE } };
        }
        setRows(next);
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => setSelected(initialIds), [initialIds]);

  const chosen = useMemo(
    () => recordings.filter((r) => selected.includes(r.id)),
    [recordings, selected],
  );
  const groups = useMemo(() => {
    const m = new Map<string, Array<{ code: string; name: string }>>();
    for (const c of project?.categories ?? []) {
      const key = c.parent ?? 'Other';
      m.set(key, [...(m.get(key) ?? []), c]);
    }
    return [...m.entries()];
  }, [project]);

  const setRow = (id: string, patch: Partial<Row>) =>
    setRows((r) => ({ ...r, [id]: { ...r[id]!, ...patch } }));
  const setConsent = (id: string, key: ConsentKey, v: boolean) =>
    setRow(id, { consent: { ...rows[id]!.consent, [key]: v } });
  const toggle = (id: string) =>
    setSelected((s) =>
      s.includes(id) ? s.filter((x) => x !== id) : [...s, id],
    );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    const missing = chosen.find((r) => !rows[r.id]?.date || !rows[r.id]?.time);
    if (missing)
      return setError(
        `${missing.originalFilename}: enter the date and time recording started.`,
      );
    const unticked = chosen.find(
      (r) => !CONSENT_KEYS.every((k) => rows[r.id]!.consent[k]),
    );
    if (unticked) {
      return setError(
        `${unticked.originalFilename}: all four consent statements must be ticked. Do not deliver footage you cannot affirm them for.`,
      );
    }
    setSaving(true);
    try {
      await api('POST', '/recordings/declaration', {
        shared,
        items: chosen.map((r) => ({
          id: r.id,
          recordedAt: new Date(
            `${rows[r.id]!.date}T${rows[r.id]!.time}`,
          ).toISOString(),
          consent: rows[r.id]!.consent as ConsentAnswers,
        })),
      });
      try {
        localStorage.setItem(LAST_SHARED, JSON.stringify(shared));
      } catch {
        /* a convenience only */
      }
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <section className="card">
        <h2>Declaration details</h2>
        <p className="small muted">
          Claru stores this declaration with every clip and relies on it.
          Declare only what is true. The collector is recorded as the person who
          uploaded the file.
        </p>
        <h2>Shared by these recordings</h2>
        <div className="grid2">
          <label>
            Category (from Claru)
            <select
              value={shared.categoryCode}
              onChange={(e) =>
                setShared({ ...shared, categoryCode: e.target.value })
              }
              required
            >
              <option value="">Choose…</option>
              {groups.map(([parent, list]) => (
                <optgroup key={parent} label={parent}>
                  {list.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name} ({c.code})
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label>
            Country (2 letters)
            <input
              value={shared.country}
              maxLength={2}
              onChange={(e) =>
                setShared({ ...shared, country: e.target.value.toUpperCase() })
              }
              required
            />
          </label>
          <label>
            Site id (your name for the place)
            <input
              value={shared.siteId}
              placeholder="hyd-kitchen-2"
              onChange={(e) => setShared({ ...shared, siteId: e.target.value })}
              required
            />
          </label>
          <label>
            Camera make and model
            <input
              value={shared.device}
              placeholder="GoPro HERO12 Black"
              onChange={(e) => setShared({ ...shared, device: e.target.value })}
              required
            />
          </label>
          <label>
            Mount
            <input
              value={shared.mount}
              placeholder="chest harness"
              list="mounts"
              onChange={(e) => setShared({ ...shared, mount: e.target.value })}
              required
            />
            <datalist id="mounts">
              <option value="chest harness" />
              <option value="head strap" />
              <option value="helmet" />
            </datalist>
          </label>
        </div>
      </section>

      <section className="card">
        <h2>Each recording</h2>
        <p className="small muted">
          Times are in your time zone ({ZONE}). Use the time recording started,
          not when the file was copied.
        </p>
        {loading ? (
          <LoadingState label="Loading received recordings…" />
        ) : (
          !error &&
          recordings.length === 0 && (
            <EmptyState title="No recordings to declare" icon="declare">
              Received recordings that have not failed checks will appear here.
            </EmptyState>
          )
        )}
        {recordings.map((r) => {
          const on = selected.includes(r.id);
          const row = rows[r.id];
          const check = checkLabel(r);
          return (
            <div key={r.id} className={on ? 'declare-row on' : 'declare-row'}>
              <label className="inline">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(r.id)}
                />
                <strong>{r.originalFilename}</strong>
                <span className="muted small">
                  {r.media ? minutes(r.media.durationSeconds) : ''} · checks:{' '}
                  <span className={check.cls}>{check.text}</span>
                  {r.declaration
                    ? ' · already declared (saving replaces it)'
                    : ''}
                </span>
              </label>
              {on && row && (
                <div className="declare-fields">
                  <div className="row wrap">
                    <label>
                      Recording started on
                      <input
                        type="date"
                        value={row.date}
                        onChange={(e) => setRow(r.id, { date: e.target.value })}
                        required
                      />
                    </label>
                    <label>
                      at
                      <input
                        type="time"
                        value={row.time}
                        onChange={(e) => setRow(r.id, { time: e.target.value })}
                        required
                      />
                    </label>
                  </div>
                  <fieldset className="consents">
                    <legend className="small">
                      Consents (all four must be true)
                    </legend>
                    {CONSENT_KEYS.map((k) => (
                      <label key={k} className="inline consent">
                        <input
                          type="checkbox"
                          checked={row.consent[k]}
                          onChange={(e) =>
                            setConsent(r.id, k, e.target.checked)
                          }
                        />
                        <span>
                          <code>{k}</code>
                          <span className="small muted">
                            {' '}
                            — {CONSENT_TEXT[k]}
                          </span>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                </div>
              )}
            </div>
          );
        })}
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p>
        <button
          className="primary"
          disabled={saving || chosen.length === 0 || !project}
        >
          {saving
            ? 'Saving…'
            : `Save declaration for ${chosen.length} recording${chosen.length === 1 ? '' : 's'}`}
        </button>{' '}
        <button type="button" className="link" onClick={onDone}>
          Back to recordings
        </button>
      </p>
    </form>
  );
}
""",
    'web/src/pages/Home.tsx': r"""import { useEffect, useState } from 'react';
import type { HealthReport, PublicUser, RecordingView } from '@cvu/shared';
import { api, errorText } from '../api.js';
import {
  EmptyState,
  Icon,
  LoadingState,
  type IconName,
} from '../components/UI.js';
import { size } from './Recordings.js';

export function HomePage({
  user,
  onGo,
}: {
  user: PublicUser;
  onGo: (page: 'upload' | 'recordings') => void;
}) {
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [recordings, setRecordings] = useState<RecordingView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    fetch('/api/healthz')
      .then((r) => r.json() as Promise<HealthReport>)
      .then((h) => {
        if (current) setHealth(h);
      })
      .catch(() => {
        if (current) setHealthError(true);
      });
    api<{ recordings: RecordingView[] }>('GET', '/recordings')
      .then((r) => {
        if (current) setRecordings(r.recordings);
      })
      .catch((e: unknown) => {
        if (current) setError(errorText(e));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, []);
  const active = recordings.filter(
    (r) => r.transferStatus === 'waiting' || r.transferStatus === 'receiving',
  ).length;
  const stats: Array<{
    label: string;
    value: number;
    icon: IconName;
    note: string;
  }> = [
    {
      label: 'Total recordings',
      value: recordings.length,
      icon: 'recordings',
      note: user.role === 'admin' ? 'Across your workspace' : 'Uploaded by you',
    },
    {
      label: 'Uploads in progress',
      value: active,
      icon: 'upload',
      note: 'Waiting or receiving files',
    },
    {
      label: 'Ready for Claru',
      value: recordings.filter((r) => r.readyForDelivery).length,
      icon: 'check',
      note: 'Checks and declaration complete',
    },
  ];
  const recent = [...recordings]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 5);
  return (
    <>
      <section className="welcome-card">
        <div>
          <span className="eyebrow">CAPTURE. UPLOAD. PREPARE.</span>
          <h2>Welcome back, {user.displayName}.</h2>
          <p>
            Great footage starts here. Bring your recordings into one organized
            workspace.
          </p>
          <button className="primary" onClick={() => onGo('upload')}>
            <Icon name="upload" />
            Upload recordings
          </button>
        </div>
        <div className="welcome-art" aria-hidden="true">
          <div className="art-orbit" />
          <div className="art-file">
            <Icon name="recordings" />
            <span>MP4</span>
          </div>
          <span className="art-check">
            <Icon name="check" />
          </span>
        </div>
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="stats-grid" aria-label="Recording summary">
        {stats.map((stat) => (
          <section className="card stat-card" key={stat.label}>
            <div className="stat-top">
              <span>{stat.label}</span>
              <span className="stat-icon">
                <Icon name={stat.icon} />
              </span>
            </div>
            <strong className="stat-value">
              {loading ? '…' : error ? '—' : stat.value}
            </strong>
            <p className="muted small">{stat.note}</p>
          </section>
        ))}
      </div>
      <div className="overview-grid">
        <section className="card">
          <div className="section-heading">
            <div>
              <h2>Recent recordings</h2>
              <p className="muted small">Your most recently added footage.</p>
            </div>
            <button className="link" onClick={() => onGo('recordings')}>
              View all <Icon name="arrow" />
            </button>
          </div>
          {loading ? (
            <LoadingState label="Loading recordings…" />
          ) : error ? (
            <p className="muted small">
              Recordings could not be loaded. Open Recordings to try again.
            </p>
          ) : recent.length === 0 ? (
            <EmptyState title="Your footage belongs here">
              Upload your first MP4 to start building your recording library.
            </EmptyState>
          ) : (
            <ul className="recent-list">
              {recent.map((r) => (
                <li key={r.id}>
                  <span className="file-icon">
                    <Icon name="recordings" />
                  </span>
                  <div>
                    <strong title={r.originalFilename}>
                      {r.originalFilename}
                    </strong>
                    <span className="muted small">
                      {size(r.sizeBytes)} ·{' '}
                      {new Date(r.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <span className={`badge ${r.readyForDelivery ? 'ok' : ''}`}>
                    {r.readyForDelivery
                      ? 'Ready'
                      : r.transferStatus.replace(/_/g, ' ')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card workflow-card">
          <p className="eyebrow">THE WORKFLOW</p>
          <h2>From camera to Claru</h2>
          <ol className="workflow-list">
            <li>
              <span>1</span>
              <div>
                <strong>Upload your footage</strong>
                <p>Resumable MP4 transfers keep your progress.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Review file checks</strong>
                <p>Check media quality and prepared clips.</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Complete the declaration</strong>
                <p>Add capture details and confirm all consents.</p>
              </div>
            </li>
          </ol>
          <div className="service-status" role="status">
            <span
              className={`status-dot ${health?.ok ? 'healthy' : health || healthError ? 'unhealthy' : ''}`}
            />
            <span>
              {health
                ? health.ok
                  ? 'Server & database available'
                  : 'Service needs attention'
                : healthError
                  ? 'Service status unavailable'
                  : 'Checking service status…'}
            </span>
          </div>
        </section>
      </div>
    </>
  );
}
""",
    'web/src/pages/Login.tsx': r"""import { useState, type FormEvent } from 'react';
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
""",
    'web/src/pages/Problems.tsx': r"""import { EmptyState, LoadingState } from '../components/UI.js';
import { useCallback, useEffect, useState } from 'react';
import type { ProblemView } from '@cvu/shared';
import { api, errorText } from '../api.js';

const SOURCE: Record<ProblemView['source'], string> = {
  server: 'Server',
  job: 'Background job',
  browser: 'Browser',
};

/**
 * Errors from the server, background jobs and testers' browsers (last 30 days).
 * For everything else, the full log is on the server: see docs/DEPLOY.md, "Logs".
 */
export function ProblemsPage() {
  const [rows, setRows] = useState<ProblemView[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    setError('');
    setLoading(true);
    api<{ problems: ProblemView[] }>('GET', '/admin/problems')
      .then((r) => setRows(r.problems))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  return (
    <section className="card">
      <div className="row spread">
        <h2>Reported problems</h2>
        <button className="link" onClick={load}>
          Refresh
        </button>
      </div>
      <p className="small muted">
        Server errors, failed background jobs and errors in testers&apos;
        browsers, newest first, kept 30 days. A tester who sees &quot;reference
        abc123&quot; can quote it: it matches the Reference column and the
        server log.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <LoadingState label="Loading problems…" />
      ) : rows.length === 0 ? (
        !error && (
          <EmptyState title="No problems recorded" icon="check">
            Errors reported by the application will appear here.
          </EmptyState>
        )
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-label="Problems table"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Where</th>
                <th>What</th>
                <th>Who</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="small nowrap">
                    {new Date(p.at).toLocaleString()}
                  </td>
                  <td className="small">
                    {SOURCE[p.source]}
                    {p.page && <div className="muted">{p.page}</div>}
                  </td>
                  <td className="small">
                    <button
                      className="link problem-toggle"
                      aria-expanded={open === p.id}
                      onClick={() => setOpen(open === p.id ? null : p.id)}
                    >
                      {p.message}
                    </button>
                    {open === p.id && (
                      <pre className="small detail-json">
                        {JSON.stringify(p.detail, null, 2)}
                      </pre>
                    )}
                  </td>
                  <td className="small">{p.user ?? '—'}</td>
                  <td className="small mono">{p.requestId ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
""",
    'web/src/pages/Recordings.tsx': r"""import { EmptyState, LoadingState } from '../components/UI.js';
import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  CONSENT_KEYS,
  type PublicUser,
  type RecordingView,
  type TransferStatus,
} from '@cvu/shared';
import { api, errorText } from '../api.js';

const LABELS: Record<TransferStatus, string> = {
  waiting: 'Waiting to start',
  receiving: 'Uploading',
  received: 'Received',
  abandoned: 'Given up (no data for 72 h)',
  cancelled: 'Cancelled',
  removed: 'Removed',
  failed: 'Failed',
};

/** In transit on the server, but no bytes for 90 s: no browser is sending it (tab closed, page reloaded, network down). */
function paused(r: RecordingView): boolean {
  if (r.transferStatus !== 'receiving' && r.transferStatus !== 'waiting')
    return false;
  const last = Date.parse(r.lastProgressAt ?? r.createdAt);
  return Date.now() - last > 90_000;
}

export function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function minutes(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m ? `${m} min ${s} s` : `${s} s`;
}

function speed(bps: number | null): string {
  if (!bps) return '—';
  return `${(bps / 1024 ** 2).toFixed(1)} MB/s · ${((bps * 8) / 1e6).toFixed(0)} Mbit/s`;
}

function transferTime(r: RecordingView): string {
  if (!r.receivedAt || !r.transferStartedAt) return '';
  const s = Math.round(
    (Date.parse(r.receivedAt) - Date.parse(r.transferStartedAt)) / 1000,
  );
  return s >= 3600
    ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`
    : minutes(s);
}

export function checkLabel(r: RecordingView): { text: string; cls: string } {
  switch (r.checkStatus) {
    case 'pending':
      return { text: 'Waiting to be checked', cls: 'muted' };
    case 'running':
      return { text: 'Checking…', cls: 'muted' };
    case 'passed':
      return { text: 'Passed', cls: 'ok' };
    case 'warned':
      return { text: 'Passed with warnings', cls: 'ok' };
    case 'failed':
      return { text: 'Failed', cls: 'error' };
    default:
      return { text: '—', cls: 'muted' };
  }
}

function clipsLabel(r: RecordingView): { text: string; cls: string } {
  if (r.splitStatus === 'failed')
    return { text: 'Could not cut', cls: 'error' };
  if (r.splitStatus === 'pending' || r.splitStatus === 'running')
    return { text: 'Cutting…', cls: 'muted' };
  if (r.splitStatus === 'done')
    return {
      text: `${r.clips.length} clip${r.clips.length === 1 ? '' : 's'}`,
      cls: '',
    };
  return { text: '—', cls: 'muted' };
}

const busy = (r: RecordingView) =>
  r.transferStatus === 'receiving' ||
  r.transferStatus === 'waiting' ||
  r.checkStatus === 'pending' ||
  r.checkStatus === 'running' ||
  r.splitStatus === 'pending' ||
  r.splitStatus === 'running';

export function RecordingsPage({
  me,
  refreshKey,
  onDeclare,
}: {
  me: PublicUser;
  refreshKey: number;
  onDeclare: (ids: string[]) => void;
}) {
  const [rows, setRows] = useState<RecordingView[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);

  const load = useCallback(() => {
    api<{ recordings: RecordingView[] }>('GET', '/recordings')
      .then((r) => {
        setRows(r.recordings);
        setError('');
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load, refreshKey]);

  // Refresh every 5 s while anything is still arriving, being checked or being cut.
  const active = rows.some(busy);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [active, load]);

  async function act(
    r: RecordingView,
    action: 'cancel' | 'remove' | 'recheck',
  ) {
    const q = {
      cancel: `Cancel the upload of ${r.originalFilename}? What has arrived so far is deleted.`,
      remove: `Delete ${r.originalFilename} and its clips from the server? This cannot be undone.`,
      recheck: null,
    }[action];
    if (q && !window.confirm(q)) return;
    try {
      await api('POST', `/recordings/${r.id}/${action}`);
      load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const received = rows.filter((r) => r.averageBytesPerSecond);
  const avg = received.length
    ? received.reduce((s, r) => s + (r.averageBytesPerSecond ?? 0), 0) /
      received.length
    : null;
  const undeclared = rows.filter(
    (r) =>
      r.transferStatus === 'received' &&
      r.checkStatus !== 'failed' &&
      !r.declaration,
  );
  const cols = me.role === 'admin' ? 7 : 6;
  // Cancelled, removed and given-up uploads stay in the record but are hidden unless asked for.
  const ENDED: TransferStatus[] = ['cancelled', 'removed', 'abandoned'];
  const endedCount = rows.filter((r) =>
    ENDED.includes(r.transferStatus),
  ).length;
  const visible = showEnded
    ? rows
    : rows.filter((r) => !ENDED.includes(r.transferStatus));

  return (
    <section className="card">
      <div className="row spread">
        <h2>Recording library</h2>
        <span>
          {undeclared.length > 0 && (
            <button
              className="primary"
              onClick={() => onDeclare(undeclared.map((r) => r.id))}
            >
              Declare {undeclared.length} recording
              {undeclared.length === 1 ? '' : 's'}
            </button>
          )}{' '}
          <button className="link" onClick={load}>
            Refresh
          </button>
        </span>
      </div>
      {avg && (
        <p className="small muted">
          Average upload speed over {received.length} received file
          {received.length === 1 ? '' : 's'}: {speed(avg)}
        </p>
      )}
      {endedCount > 0 && (
        <label className="inline small muted">
          <input
            type="checkbox"
            checked={showEnded}
            onChange={(e) => setShowEnded(e.target.checked)}
          />
          Show {endedCount} cancelled or removed
        </label>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <LoadingState label="Loading recordings…" />
      ) : visible.length === 0 ? (
        !error && (
          <EmptyState title="No recordings to show">
            Upload an MP4 to get started, or include cancelled and removed
            uploads above.
          </EmptyState>
        )
      ) : (
        <div
          className="table-scroll"
          role="region"
          aria-label="Recordings table"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>File</th>
                {me.role === 'admin' && <th>Uploaded by</th>}
                <th>Transfer</th>
                <th>Checks</th>
                <th>Clips</th>
                <th>Declaration</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const pct = Math.floor((r.receivedBytes / r.sizeBytes) * 100);
                const check = checkLabel(r);
                const clips = clipsLabel(r);
                const isOpen = open === r.id;
                return (
                  <Fragment key={r.id}>
                    <tr>
                      <td>
                        {r.originalFilename}
                        <div className="muted small">
                          {size(r.sizeBytes)}
                          {r.media
                            ? ` · ${minutes(r.media.durationSeconds)}`
                            : ''}{' '}
                          · {new Date(r.createdAt).toLocaleDateString()}
                        </div>
                      </td>
                      {me.role === 'admin' && (
                        <td>{r.uploadedBy.displayName}</td>
                      )}
                      <td>
                        <span
                          className={`badge ${r.transferStatus === 'received' ? 'ok' : r.transferStatus === 'failed' ? 'error' : ''}`}
                        >
                          {paused(r) ? 'Paused' : LABELS[r.transferStatus]}
                        </span>
                        {r.transferStatus === 'receiving' && (
                          <>
                            <progress max={100} value={pct} />{' '}
                            <span className="small">{pct}%</span>
                          </>
                        )}
                        {r.failureReason && (
                          <div className="small muted">{r.failureReason}</div>
                        )}
                        {paused(r) && (
                          <div className="small muted">
                            No data for a while. To continue, add the same file
                            on the Upload page.
                          </div>
                        )}
                        {r.averageBytesPerSecond && (
                          <div className="small muted">
                            {speed(r.averageBytesPerSecond)} · {transferTime(r)}
                          </div>
                        )}
                      </td>
                      <td className={check.cls}>
                        {check.text}
                        {r.problems.length > 0 && (
                          <div className="small muted">
                            {r.problems.map((p) => p.code).join(', ')}
                          </div>
                        )}
                      </td>
                      <td className={clips.cls}>{clips.text}</td>
                      <td>
                        {r.readyForDelivery ? (
                          <span className="badge ok">Ready for Claru</span>
                        ) : r.declaration ? (
                          <span>Declared</span>
                        ) : r.transferStatus === 'received' &&
                          r.checkStatus !== 'failed' ? (
                          <button
                            className="link"
                            onClick={() => onDeclare([r.id])}
                          >
                            Declare
                          </button>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="actions">
                        {r.transferStatus === 'received' && (
                          <button
                            className="link"
                            onClick={() => setOpen(isOpen ? null : r.id)}
                          >
                            {isOpen ? 'Hide' : 'Details'}
                          </button>
                        )}
                        {(r.transferStatus === 'waiting' ||
                          r.transferStatus === 'receiving') && (
                          <button
                            className="link"
                            onClick={() => act(r, 'cancel')}
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="detail">
                        <td colSpan={cols}>
                          <Details
                            r={r}
                            onAct={(a) => act(r, a)}
                            onDeclare={() => onDeclare([r.id])}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">
        Speed is measured from the first to the last byte, including any pauses.
      </p>
    </section>
  );
}

function Details({
  r,
  onAct,
  onDeclare,
}: {
  r: RecordingView;
  onAct: (a: 'remove' | 'recheck') => void;
  onDeclare: () => void;
}) {
  const d = r.declaration;
  return (
    <div className="details">
      <div>
        <h3>Checks</h3>
        {r.media && (
          <p className="small">
            {r.media.width}×{r.media.height} · {r.media.fps} fps ·{' '}
            {r.media.videoCodec} · {minutes(r.media.durationSeconds)}
            {r.media.hasAudio ? ' · audio' : ' · no audio'}
            {r.media.hasTelemetry ? ' · telemetry track' : ''} · keyframes ≤{' '}
            {r.media.maxKeyframeGapSeconds} s apart
          </p>
        )}
        {r.problems.length === 0 &&
          r.checkStatus &&
          r.checkStatus !== 'pending' &&
          r.checkStatus !== 'running' && (
            <p className="small ok">Nothing that Claru would refuse.</p>
          )}
        <ul className="small problems">
          {r.problems.map((p, i) => (
            <li
              key={i}
              className={
                p.level === 'error'
                  ? 'error'
                  : p.level === 'warn'
                    ? ''
                    : 'muted'
              }
            >
              <strong>
                {p.level === 'error'
                  ? 'Blocks delivery'
                  : p.level === 'warn'
                    ? 'Warning'
                    : 'Note'}
              </strong>{' '}
              ({p.code}): {p.message}
            </li>
          ))}
        </ul>
        {r.checkStatus === 'failed' && (
          <p className="small muted">
            Claru would refuse this file, so it will not be delivered. Fix it at
            the camera and upload a new recording, or, if the problem was not
            the file, check again.
          </p>
        )}
      </div>

      <div>
        <h3>Clips</h3>
        {r.splitError && <p className="small error">{r.splitError}</p>}
        {r.clips.length > 0 ? (
          <ol className="small">
            {r.clips.map((c) => (
              <li key={c.seq}>
                from {minutes(c.startSeconds)}, {minutes(c.durationSeconds)},{' '}
                {size(c.sizeBytes)}{' '}
                <span className="mono muted">{c.externalRef}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="small muted">None yet.</p>
        )}
        {r.clips.length === 1 && (
          <p className="small muted">
            Up to 30 minutes: delivered as one clip, uncut.
          </p>
        )}
      </div>

      <div>
        <h3>Declaration</h3>
        {d ? (
          <dl className="small kv">
            <dt>Category</dt>
            <dd>{d.categoryCode}</dd>
            <dt>Country · site</dt>
            <dd>
              {d.country} · {d.siteId}
            </dd>
            <dt>Device · mount</dt>
            <dd>
              {d.device} · {d.mount}
            </dd>
            <dt>Recorded at</dt>
            <dd>{new Date(d.recordedAt).toLocaleString()}</dd>
            <dt>Consents</dt>
            <dd>
              {CONSENT_KEYS.every((k) => d.consent[k])
                ? 'all four affirmed'
                : 'incomplete'}
            </dd>
            <dt>Declared</dt>
            <dd>
              by {d.declaredBy}, {new Date(d.declaredAt).toLocaleString()}
            </dd>
          </dl>
        ) : (
          <p className="small muted">Not declared yet.</p>
        )}
        {r.checkStatus !== 'failed' && (
          <button className="link" onClick={onDeclare}>
            {d ? 'Change declaration' : 'Declare'}
          </button>
        )}
      </div>

      <div className="row">
        {(r.checkStatus === 'failed' ||
          r.splitStatus === 'failed' ||
          r.checkStatus === 'passed' ||
          r.checkStatus === 'warned') && (
          <button className="link" onClick={() => onAct('recheck')}>
            Check again
          </button>
        )}
        <button className="link danger" onClick={() => onAct('remove')}>
          Delete recording
        </button>
      </div>
    </div>
  );
}
""",
    'web/src/pages/Upload.tsx': r"""import { useCallback, useEffect, useRef, useState } from 'react';
import Uppy, { type Meta, type UppyFile } from '@uppy/core';
import Dashboard from '@uppy/dashboard';
import Tus from '@uppy/tus';
import '@uppy/core/css/style.min.css';
import '@uppy/dashboard/css/style.min.css';
import {
  fingerprintFromSamples,
  fingerprintRanges,
  type PublicUser,
  type RecordingView,
} from '@cvu/shared';
import { api, errorText } from '../api.js';
import { reportProblem } from '../reporter.js';
import type { Theme } from '../theme.js';
import { size } from './Recordings.js';

type FileMeta = Meta & { recordingId?: string };
type Body = Record<string, never>;

interface Problem {
  name: string;
  message: string;
}

const CHUNK_BYTES = 50 * 1024 * 1024;
// Keep retrying for about 10 minutes (Wi-Fi drops, server restarts); after
// that the file shows a retry button, and coming back online retries anyway.
const RETRY_DELAYS = [
  0, 1000, 3000, 5000, 10000, 20000, 30000, 60000, 60000, 60000, 60000, 60000,
  60000, 60000, 60000,
];

async function fingerprintOf(file: Blob): Promise<string> {
  const { head, tail } = fingerprintRanges(file.size);
  const read = async ([a, b]: [number, number]) =>
    new Uint8Array(await file.slice(a, b).arrayBuffer());
  return fingerprintFromSamples(file.size, await read(head), await read(tail));
}

/**
 * Uploads with Uppy + tus. Before any bytes move, each file is declared to the
 * server (name, size, fingerprint). The server answers with a recording id,
 * which is also the upload's address — so the same file added again later, in
 * any browser, continues from where the server says it stopped.
 */
export function UploadPage({
  me,
  onUploaded,
  theme,
}: {
  me: PublicUser;
  onUploaded: () => void;
  theme: Theme;
}) {
  const target = useRef<HTMLDivElement>(null);
  const uppyRef = useRef<Uppy<FileMeta, Body> | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [busy, setBusy] = useState(false);
  const [unfinished, setUnfinished] = useState<RecordingView[]>([]);
  const notify = useRef(onUploaded);
  notify.current = onUploaded;

  /**
   * Your uploads the server is still waiting for, that this tab is not sending.
   * A browser cannot reopen a file by itself after a reload or a closed tab,
   * so these need you to add the same file again.
   */
  const loadUnfinished = useCallback(() => {
    api<{ recordings: RecordingView[] }>('GET', '/recordings')
      .then((r) => {
        const inThisTab = new Set(
          uppyRef.current?.getFiles().map((f) => f.meta.recordingId) ?? [],
        );
        setUnfinished(
          r.recordings.filter(
            (x) =>
              x.uploadedBy.id === me.id &&
              (x.transferStatus === 'waiting' ||
                x.transferStatus === 'receiving') &&
              !inThisTab.has(x.id),
          ),
        );
      })
      .catch(() => undefined);
  }, [me.id]);

  useEffect(() => {
    const uppy = new Uppy<FileMeta, Body>({
      autoProceed: false,
      restrictions: { allowedFileTypes: ['.mp4', 'video/mp4'] },
    });
    uppyRef.current = uppy;

    uppy.use(Dashboard, {
      target: target.current!,
      inline: true,
      width: '100%',
      height: 440,
      theme: 'auto',
      proudlyDisplayPoweredByUppy: false,
      note: 'MP4 files only. Two files upload at a time; the rest wait their turn.',
    });

    uppy.use(Tus, {
      endpoint: '/api/uploads',
      headers: { 'X-Requested-With': 'cvu' },
      chunkSize: CHUNK_BYTES,
      limit: 2,
      retryDelays: RETRY_DELAYS,
      allowedMetaFields: ['recordingId'],
      // The resume address comes from the server (see below), not from browser storage.
      storeFingerprintForResuming: false,
    });

    uppy.addPreProcessor(async (fileIDs) => {
      for (const id of fileIDs) {
        const file = uppy.getFile(id) as UppyFile<FileMeta, Body> | undefined;
        if (!file || file.meta.recordingId || !(file.data instanceof Blob))
          continue;
        uppy.emit('preprocess-progress', file, {
          mode: 'indeterminate',
          message: 'Checking file…',
        });
        try {
          const fingerprint = await fingerprintOf(file.data);
          const r = await api<{ recording: RecordingView; resumed: boolean }>(
            'POST',
            '/recordings',
            {
              filename: file.name,
              sizeBytes: file.size,
              fingerprint,
            },
          );
          uppy.setFileMeta(id, { recordingId: r.recording.id });
          if (r.resumed && r.recording.transferStatus === 'receiving') {
            // Interrupted earlier (tab closed, page reloaded, other browser): ask the server
            // how much it already has and send only the rest.
            uppy.setFileState(id, {
              tus: { uploadUrl: `/api/uploads/${r.recording.id}` },
            });
          }
          uppy.emit('preprocess-complete', uppy.getFile(id));
        } catch (err) {
          setProblems((p) => [
            ...p,
            { name: file.name ?? 'file', message: errorText(err) },
          ]);
          uppy.removeFile(id);
        }
      }
    });

    uppy.on('upload', () => setBusy(true));
    uppy.on('complete', () => {
      setBusy(false);
      loadUnfinished();
    });
    uppy.on('upload-start', () => loadUnfinished());
    uppy.on('file-removed', () => loadUnfinished());
    uppy.on('upload-success', (file) => {
      notify.current();
      // Clear finished files after a moment so the drop area is ready for the next batch.
      if (file) {
        setTimeout(() => {
          if (uppy.getFile(file.id)) uppy.removeFile(file.id);
        }, 4000);
      }
    });
    uppy.on('upload-error', (file, error) => {
      const text = String(error?.message ?? error);
      reportProblem({
        kind: 'upload',
        message: `${file?.name ?? 'file'}: ${text}`.slice(0, 1000),
      });
      if (/does not match|cancelled|not found/i.test(text)) {
        setProblems((p) => [
          ...p,
          {
            name: file?.name ?? 'file',
            message:
              text
                .replace(/^.*response text: /s, '')
                .split(', request id')[0] ?? text,
          },
        ]);
      }
    });
    // Uppy notices the network coming back; resume everything that gave up meanwhile.
    uppy.on('back-online', () => void uppy.retryAll());

    const warn = (e: BeforeUnloadEvent) => {
      const uploading = uppy
        .getFiles()
        .some((f) => f.progress.uploadStarted && !f.progress.uploadComplete);
      if (uploading) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    loadUnfinished();
    const timer = setInterval(loadUnfinished, 15000);

    return () => {
      clearInterval(timer);
      window.removeEventListener('beforeunload', warn);
      uppyRef.current = null;
      uppy.destroy();
    };
  }, [loadUnfinished]);

  useEffect(() => {
    uppyRef.current
      ?.getPlugin<Dashboard<FileMeta, Body>>('Dashboard')
      ?.setOptions({ theme });
  }, [theme]);

  return (
    <>
      <section className="card">
        <h2>Add your footage</h2>
        <p className="small muted">
          Add one or more MP4 files and press Upload. Each file is checked
          against the server first, so the same recording is never uploaded
          twice.
        </p>
        <details className="small">
          <summary>If the upload is interrupted</summary>
          <ul>
            <li>
              Wi-Fi drops or the server restarts: it keeps retrying on its own
              and continues where it stopped.
            </li>
            <li>
              The tab was closed or reloaded: the browser cannot pick the file
              up again by itself. Open this page, add the{' '}
              <strong>same file</strong> and press Upload. Only the missing part
              is sent.
            </li>
            <li>
              Nothing arrives for 72 hours: the partial upload is deleted and
              you start again.
            </li>
          </ul>
        </details>
        {busy && (
          <p className="small notice-inline">
            Uploading — keep this tab open. You can use the other pages
            meanwhile.
          </p>
        )}
      </section>

      {unfinished.length > 0 && (
        <section className="card notice" role="status">
          <h2>Unfinished uploads</h2>
          <p className="small">
            The server is waiting for the rest of these. Add the same file below
            and press Upload to continue.
          </p>
          <ul className="small">
            {unfinished.map((r) => (
              <li key={r.id}>
                <strong>{r.originalFilename}</strong> — {size(r.receivedBytes)}{' '}
                of {size(r.sizeBytes)} received (
                {Math.floor((r.receivedBytes / r.sizeBytes) * 100)}%)
              </li>
            ))}
          </ul>
        </section>
      )}

      {problems.length > 0 && (
        <section className="card notice" role="alert">
          <h2>Not uploaded</h2>
          <ul className="small">
            {problems.map((p, i) => (
              <li key={i}>
                <strong>{p.name}</strong>: {p.message}
              </li>
            ))}
          </ul>
          <button className="link" onClick={() => setProblems([])}>
            Clear
          </button>
        </section>
      )}

      <div ref={target} />
    </>
  );
}
""",
    'web/src/pages/Users.tsx': r"""import { EmptyState, LoadingState } from '../components/UI.js';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PublicUser, UserSummary } from '@cvu/shared';
import { api, errorText } from '../api.js';

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export function UsersPage({ me }: { me: PublicUser }) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{
    username: string;
    password: string;
    what: string;
  } | null>(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');

  const load = useCallback(() => {
    setError('');
    api<{ users: UserSummary[] }>('GET', '/admin/users')
      .then((r) => setUsers(r.users))
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ user: PublicUser; temporaryPassword: string }>(
        'POST',
        '/admin/users',
        { username, displayName },
      );
      setNotice({
        username: r.user.username,
        password: r.temporaryPassword,
        what: 'created',
      });
      setUsername('');
      setDisplayName('');
      load();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function act(
    u: UserSummary,
    action: 'disable' | 'enable' | 'reset-password' | 'revoke-sessions',
  ) {
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
      const r = await api<{ temporaryPassword?: string }>(
        'POST',
        `/admin/users/${u.id}/${action}`,
      );
      if (r.temporaryPassword)
        setNotice({
          username: u.username,
          password: r.temporaryPassword,
          what: 'reset',
        });
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
            Give it to {notice.username} in person or by phone. It is shown only
            now; they must choose their own password at first sign-in.
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
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="ravi.k"
              required
            />
          </label>
          <label>
            Display name
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Ravi Kumar"
              required
            />
          </label>
          <button className="primary">Create</button>
        </form>
        <p className="muted small">
          Usernames: 2–32 lowercase letters, digits, dot, dash or underscore.
        </p>
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <section className="card">
        <h2>Workspace members</h2>
        {loading ? (
          <LoadingState label="Loading users…" />
        ) : !error && users.length === 0 ? (
          <EmptyState title="No users found" />
        ) : (
          <div
            className="table-scroll"
            role="region"
            aria-label="Users table"
            tabIndex={0}
          >
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
                    <td>
                      <span className="badge">{u.role}</span>
                    </td>
                    <td>
                      <span
                        className={`badge ${u.disabled ? 'error' : u.mustChangePassword ? '' : 'ok'}`}
                      >
                        {u.disabled
                          ? 'Disabled'
                          : u.mustChangePassword
                            ? 'Must set password'
                            : 'Active'}
                      </span>
                    </td>
                    <td>{when(u.lastSignInAt)}</td>
                    <td>
                      {u.activeSessions} device
                      {u.activeSessions === 1 ? '' : 's'}
                    </td>
                    <td className="actions">
                      {u.role === 'consultant' && u.id !== me.id && (
                        <>
                          {u.disabled ? (
                            <button
                              className="link"
                              onClick={() => act(u, 'enable')}
                            >
                              Enable
                            </button>
                          ) : (
                            <button
                              className="link"
                              onClick={() => act(u, 'disable')}
                            >
                              Disable
                            </button>
                          )}
                          <button
                            className="link"
                            onClick={() => act(u, 'reset-password')}
                          >
                            Reset password
                          </button>
                          {u.activeSessions > 0 && (
                            <button
                              className="link"
                              onClick={() => act(u, 'revoke-sessions')}
                            >
                              Sign out everywhere
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
""",
    'scripts/frontend.sh': r"""#!/usr/bin/env bash
# Run from any directory. Uses the cloud Node 22 install when available.
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -x /workspace/.cloud-setup/node22/node_modules/.bin/node ]]; then
  export PATH="/workspace/.cloud-setup/node22/node_modules/.bin:$PATH"
fi
cd "$repo_dir"
case "${1:-check}" in
  check)
    npm run check
    npm run build -w @cvu/web
    git diff --check
    ;;
  dev) npm run dev ;;
  build) npm run build -w @cvu/web ;;
  *) printf 'Usage: %s [check|dev|build]\n' "$0" >&2; exit 2 ;;
esac
""",
    'docs/FRONTEND.md': r"""# Dashboard development

The UI uses the existing React/Vite workspaces and state-based page navigation.
API calls, session cookies, CSRF protection, server validation, and admin/consultant
authorization remain in the existing modules. Upload stays mounted when navigating
away so active tus transfers can finish.

## Commands

Use Node 22, installed npm dependencies, PostgreSQL, and ffmpeg/ffprobe as described
in the main README. In the prepared cloud environment, start the retained database
with the saved environment startup instructions before starting development.

From the repository root:

```bash
./scripts/frontend.sh dev
```

In a second terminal:

```bash
./scripts/frontend.sh check
```

The check command runs all workspace type checks, lint, and tests, then the web
production build and Git whitespace check. Server tests reset the configured
`TEST_DATABASE_URL` database, which must have a name ending in `_test`; never point
it at the development database. Use `./scripts/frontend.sh build` for just the web
build. The script resolves its own working directory and uses the prepared cloud
Node 22 installation when present. It does not install or rewrite dependencies.

## UI conventions

- Design tokens and responsive layouts live in `web/src/styles.css`.
- `web/src/components/UI.tsx` provides SVG icons, loading and empty states.
- Theme selection defaults to the system preference and is saved as `cvu.theme`.
  Sidebar collapse is saved as `cvu.sidebar`. Both still function when storage is
  unavailable. Uppy receives theme updates without recreating its upload instance.
- Desktop uses a collapsible sidebar. At 900px and below, navigation uses a native
  modal dialog with keyboard focus containment, Escape dismissal, a close button,
  and focus restoration. Wide tables scroll inside labelled keyboard-accessible
  regions rather than widening the page.
- Overview metrics and recent recordings come from the existing role-scoped
  recordings endpoint. There are no synthetic metrics, search, or notification
  controls. The service indicator uses the existing health endpoint.

When changing the shell, verify both roles, forced password changes, logout,
light/dark preference persistence, mobile drawer keyboard behavior, and an upload
that continues while navigating. Check all pages at desktop, tablet, and narrow
mobile widths, including recording details and declaration consent fields.
""",
}

def digest(data):
    return hashlib.sha256(data).hexdigest()

changes = []
for relative, source in FILES.items():
    target = root / relative
    for component in [target, *target.parents]:
        if component == root:
            break
        if component.is_symlink():
            raise SystemExit(f'Refusing to write through symlink: {component}')
    expected = source.encode('utf-8')
    if target.exists():
        if not target.is_file():
            raise SystemExit(f'Expected a file: {relative}')
        current = target.read_bytes()
        if current == expected:
            continue
        if ORIGINAL_HASHES[relative] is None or digest(current) != ORIGINAL_HASHES[relative]:
            raise SystemExit(f'Preserved local changes in {relative}. This update targets the original frontend revision; no files have been changed.')
    elif ORIGINAL_HASHES[relative] is not None:
        raise SystemExit(f'Missing original file: {relative}. No files have been changed.')
    changes.append((relative, target, expected))

if changes:
    backup = Path(tempfile.mkdtemp(prefix='claru-dashboard-backup-'))
    originals = []
    for relative, target, expected in changes:
        if target.exists():
            saved = backup / relative
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, saved)
            originals.append(relative)
    (backup / 'backup-manifest.json').write_text(json.dumps({'repository': str(root), 'existing_files': originals, 'new_files': [r for r,t,b in changes if not t.exists()]}, indent=2))
    print(f'Backup: {backup}', flush=True)
    written = []
    try:
        for relative, target, expected in changes:
            target.parent.mkdir(parents=True, exist_ok=True)
            previous_mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else 0o644
            mode = 0o755 if relative == 'scripts/frontend.sh' else previous_mode
            fd, temp_name = tempfile.mkstemp(prefix='.claru-update-', dir=target.parent)
            try:
                with os.fdopen(fd, 'wb') as out:
                    out.write(expected)
                os.chmod(temp_name, mode)
                os.replace(temp_name, target)
                written.append((relative, target))
            finally:
                if os.path.exists(temp_name):
                    os.unlink(temp_name)
    except BaseException:
        for relative, target in reversed(written):
            saved = backup / relative
            if saved.exists():
                shutil.copy2(saved, target)
            else:
                target.unlink()
        raise
    print(f'Applied {len(changes)} frontend files. APIs, backend, dependencies, and lockfile are unchanged.')
else:
    print('The complete dashboard update is already applied.')
workflow = root / 'scripts/frontend.sh'
workflow.chmod(workflow.stat().st_mode | stat.S_IXUSR)
CLARU_COMPLETE_FRONTEND_PAYLOAD
cd -- "$repo_dir"
git diff --check
if [[ "$apply_only" == 0 ]]; then
  if [[ -x /workspace/.cloud-setup/node22/node_modules/.bin/node ]]; then
    export PATH="/workspace/.cloud-setup/node22/node_modules/.bin:$PATH"
  fi
  command -v node >/dev/null || { printf 'Code applied. Install Node 22+, then run ./scripts/frontend.sh check.\n' >&2; exit 1; }
  command -v npm >/dev/null || { printf 'Code applied. Install npm, then run ./scripts/frontend.sh check.\n' >&2; exit 1; }
  node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { process.stderr.write("Node 22+ is required.\n"); process.exit(1); }'
  if [[ ! -x node_modules/.bin/tsc ]]; then
    if [[ -d /workspace/.cloud-setup ]]; then
      npm ci --cache /workspace/.npm-cache --no-audit --no-fund
    else
      npm ci --no-audit --no-fund
    fi
  fi
  # Requires your existing local PostgreSQL/test database, .env, and ffmpeg setup.
  if ! bash scripts/frontend.sh check; then
    printf 'Validation failed. Applied source and backups were preserved; no commit was created. Review the command output above.\n' >&2
    exit 1
  fi
fi
git status --short
printf '\nUpdate applied. Review with git diff, then commit when ready.\n'
