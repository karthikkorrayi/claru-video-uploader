import { useEffect, useState } from 'react';
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
