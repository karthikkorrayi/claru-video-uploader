import { useEffect, useState } from 'react';
import type { HealthReport } from '@cvu/shared';

type State = { kind: 'loading' } | { kind: 'ok'; health: HealthReport } | { kind: 'error'; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    fetch('/api/healthz')
      .then(async (r) => {
        const body = (await r.json()) as HealthReport;
        setState(r.ok ? { kind: 'ok', health: body } : { kind: 'error', message: body.db.error ?? `HTTP ${r.status}` });
      })
      .catch((e: unknown) => setState({ kind: 'error', message: String(e) }));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 560, margin: '64px auto', padding: '0 16px' }}>
      <h1>Claru Video Uploader</h1>
      <p>Phase L0 — project skeleton</p>
      {state.kind === 'loading' && <p>Checking the server…</p>}
      {state.kind === 'ok' && (
        <p style={{ color: '#1d7a46' }}>
          ✓ Server and database are up (PostgreSQL {state.health.db.version}, {state.health.db.latencyMs} ms)
        </p>
      )}
      {state.kind === 'error' && <p style={{ color: '#b42318' }}>✗ {state.message}</p>}
    </main>
  );
}
