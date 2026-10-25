import { EmptyState, LoadingState } from '../components/UI.js';
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
