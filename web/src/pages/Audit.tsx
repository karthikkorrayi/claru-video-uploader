import { EmptyState, LoadingState } from '../components/UI.js';
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
