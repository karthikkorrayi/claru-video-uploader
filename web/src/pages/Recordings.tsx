import { useCallback, useEffect, useState } from 'react';
import type { PublicUser, RecordingView, TransferStatus } from '@cvu/shared';
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
  if (r.transferStatus !== 'receiving' && r.transferStatus !== 'waiting') return false;
  const last = Date.parse(r.lastProgressAt ?? r.createdAt);
  return Date.now() - last > 90_000;
}

export function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function speed(bps: number | null): string {
  if (!bps) return '—';
  return `${(bps / 1024 ** 2).toFixed(1)} MB/s · ${((bps * 8) / 1e6).toFixed(0)} Mbit/s`;
}

function duration(r: RecordingView): string {
  if (!r.receivedAt || !r.transferStartedAt) return '';
  const s = Math.round((Date.parse(r.receivedAt) - Date.parse(r.transferStartedAt)) / 1000);
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

export function RecordingsPage({ me, refreshKey }: { me: PublicUser; refreshKey: number }) {
  const [rows, setRows] = useState<RecordingView[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api<{ recordings: RecordingView[] }>('GET', '/recordings')
      .then((r) => {
        setRows(r.recordings);
        setError('');
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);

  useEffect(load, [load, refreshKey]);

  // Refresh every 5 s while anything is still arriving.
  const active = rows.some((r) => r.transferStatus === 'receiving' || r.transferStatus === 'waiting');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [active, load]);

  async function act(r: RecordingView, action: 'cancel' | 'remove') {
    const q =
      action === 'cancel'
        ? `Cancel the upload of ${r.originalFilename}? What has arrived so far is deleted.`
        : `Delete ${r.originalFilename} from the server? This cannot be undone.`;
    if (!window.confirm(q)) return;
    try {
      await api('POST', `/recordings/${r.id}/${action}`);
      load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const received = rows.filter((r) => r.averageBytesPerSecond);
  const avg = received.length ? received.reduce((s, r) => s + (r.averageBytesPerSecond ?? 0), 0) / received.length : null;

  return (
    <section className="card">
      <div className="row spread">
        <h1>Recordings</h1>
        <button className="link" onClick={load}>
          Refresh
        </button>
      </div>
      {avg && (
        <p className="small muted">
          Average upload speed over {received.length} received file{received.length === 1 ? '' : 's'}: {speed(avg)}
        </p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {rows.length === 0 ? (
        <p className="muted">No recordings yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>File</th>
              {me.role === 'admin' && <th>Uploaded by</th>}
              <th>Size</th>
              <th>Transfer</th>
              <th>Speed</th>
              <th>Added</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pct = Math.floor((r.receivedBytes / r.sizeBytes) * 100);
              return (
                <tr key={r.id}>
                  <td>
                    {r.originalFilename}
                    <div className="muted small mono">{r.id.slice(0, 8)}</div>
                  </td>
                  {me.role === 'admin' && <td>{r.uploadedBy.displayName}</td>}
                  <td className="nowrap">{size(r.sizeBytes)}</td>
                  <td>
                    <span className={r.transferStatus === 'received' ? 'ok' : r.transferStatus === 'failed' ? 'error' : ''}>
                      {paused(r) ? 'Paused' : LABELS[r.transferStatus]}
                    </span>
                    {r.transferStatus === 'receiving' && (
                      <>
                        <progress max={100} value={pct} /> <span className="small">{pct}%</span>
                      </>
                    )}
                    {r.failureReason && <div className="small muted">{r.failureReason}</div>}
                    {paused(r) && <div className="small muted">No data for a while. To continue, add the same file on the Upload page.</div>}
                  </td>
                  <td className="small">
                    {speed(r.averageBytesPerSecond)}
                    <div className="muted">{duration(r)}</div>
                  </td>
                  <td className="small nowrap">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="actions">
                    {(r.transferStatus === 'waiting' || r.transferStatus === 'receiving') && (
                      <button className="link" onClick={() => act(r, 'cancel')}>
                        Cancel
                      </button>
                    )}
                    {r.transferStatus === 'received' && (
                      <button className="link" onClick={() => act(r, 'remove')}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="small muted">Speed is measured from the first to the last byte, including any pauses.</p>
    </section>
  );
}
