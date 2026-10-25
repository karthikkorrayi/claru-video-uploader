import { useCallback, useEffect, useState } from 'react';
import type { ProblemView } from '@cvu/shared';
import { api, errorText } from '../api.js';

const SOURCE: Record<ProblemView['source'], string> = { server: 'Server', job: 'Background job', browser: 'Browser' };

/**
 * Errors from the server, background jobs and testers' browsers (last 30 days).
 * For everything else, the full log is on the server: see docs/DEPLOY.md, "Logs".
 */
export function ProblemsPage() {
  const [rows, setRows] = useState<ProblemView[]>([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ problems: ProblemView[] }>('GET', '/admin/problems')
      .then((r) => setRows(r.problems))
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  return (
    <section className="card">
      <div className="row spread">
        <h1>Problems</h1>
        <button className="link" onClick={load}>
          Refresh
        </button>
      </div>
      <p className="small muted">
        Server errors, failed background jobs and errors in testers&apos; browsers, newest first, kept 30 days. A tester who sees
        &quot;reference abc123&quot; can quote it: it matches the Reference column and the server log.
      </p>
      {error && <p className="error">{error}</p>}
      {rows.length === 0 ? (
        <p className="ok">No problems recorded.</p>
      ) : (
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
              <tr key={p.id} onClick={() => setOpen(open === p.id ? null : p.id)} className="clickable">
                <td className="small nowrap">{new Date(p.at).toLocaleString()}</td>
                <td className="small">
                  {SOURCE[p.source]}
                  {p.page && <div className="muted">{p.page}</div>}
                </td>
                <td className="small">
                  {p.message}
                  {open === p.id && <pre className="small detail-json">{JSON.stringify(p.detail, null, 2)}</pre>}
                </td>
                <td className="small">{p.user ?? '—'}</td>
                <td className="small mono">{p.requestId ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
