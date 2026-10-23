import { useEffect, useState } from 'react';
import type { AuditView } from '@cvu/shared';
import { api, errorText } from '../api.js';

export function AuditPage() {
  const [entries, setEntries] = useState<AuditView[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ entries: AuditView[] }>('GET', '/admin/audit?limit=200')
      .then((r) => setEntries(r.entries))
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  return (
    <section className="card">
      <h2>Audit log</h2>
      <p className="muted small">Sign-ins, failures and account changes, newest first. Passwords are never recorded.</p>
      {error && <p className="error">{error}</p>}
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
              <td className="small mono">{Object.keys(e.details).length ? JSON.stringify(e.details) : ''}</td>
              <td className="small">{e.ip ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
