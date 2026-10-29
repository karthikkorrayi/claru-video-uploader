import { EmptyState, LoadingState } from '../components/UI.js';
import { Fragment, useCallback, useEffect, useState } from 'react';
import {
  CONSENT_KEYS,
  type ClipView,
  type DeliveryState,
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

/** Claru's states, as the consultant reads them. */
export const DELIVERY: Record<DeliveryState, { text: string; cls: string }> = {
  pending: { text: 'Waiting to send', cls: 'muted' },
  draft: { text: 'Sending…', cls: 'muted' },
  processing: { text: 'Accepted, processing', cls: '' },
  in_review: { text: 'In review at Claru', cls: '' },
  approved: { text: 'Approved', cls: 'ok' },
  rejected: { text: 'Rejected', cls: 'error' },
  refused: { text: 'Refused', cls: 'error' },
  expired: { text: 'Expired (not sealed in 14 days)', cls: 'error' },
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

/** One line for the Claru column: the worst state among the clips, with a count. */
function claruSummary(
  r: RecordingView,
): { text: string; cls: string; overdue: boolean } | null {
  const subs = r.clips
    .map((c) => c.submission)
    .filter((s): s is NonNullable<ClipView['submission']> => !!s);
  if (!subs.length) return null;
  const order: DeliveryState[] = [
    'refused',
    'rejected',
    'expired',
    'draft',
    'pending',
    'processing',
    'in_review',
    'approved',
  ];
  const worst = order.find((st) => subs.some((s) => s.state === st))!;
  const n = subs.filter((s) => s.state === worst).length;
  const label = DELIVERY[worst];
  return {
    text:
      r.clips.length > 1
        ? `${label.text} (${n}/${r.clips.length})`
        : label.text,
    cls: label.cls,
    overdue: subs.some((s) => s.overdue),
  };
}

const busy = (r: RecordingView) =>
  r.transferStatus === 'receiving' ||
  r.transferStatus === 'waiting' ||
  r.checkStatus === 'pending' ||
  r.checkStatus === 'running' ||
  r.splitStatus === 'pending' ||
  r.splitStatus === 'running' ||
  r.clips.some(
    (c) =>
      c.submission &&
      ['pending', 'draft', 'processing'].includes(c.submission.state),
  );

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

  // Refresh every 5 s while anything is arriving, being checked or cut, or on its way to Claru.
  const active = rows.some(busy);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [active, load]);

  async function post(path: string, body?: unknown, question?: string) {
    if (question && !window.confirm(question)) return;
    try {
      await api('POST', path, body);
      load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  const act = (
    r: RecordingView,
    action: 'cancel' | 'remove' | 'recheck' | 'retry-delivery',
  ) =>
    post(
      `/recordings/${r.id}/${action}`,
      undefined,
      {
        cancel: `Cancel the upload of ${r.originalFilename}? What has arrived so far is deleted.`,
        remove: `Delete ${r.originalFilename} and its clips from the server? This cannot be undone.`,
        recheck: undefined,
        'retry-delivery': `Send the refused clips of ${r.originalFilename} to Claru again, under the same reference?`,
      }[action],
    );

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
                <th>Claru</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const pct = Math.floor((r.receivedBytes / r.sizeBytes) * 100);
                const check = checkLabel(r);
                const clips = clipsLabel(r);
                const claru = claruSummary(r);
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
                        {claru ? (
                          <>
                            <span className={`badge ${claru.cls}`}>
                              {claru.text}
                            </span>
                            {claru.overdue && (
                              <div className="small error">Review overdue</div>
                            )}
                          </>
                        ) : r.readyForDelivery ? (
                          <span className="muted">Waiting to send</span>
                        ) : r.declaration ? (
                          <span className="muted">
                            Declared; waiting for clips
                          </span>
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
                            me={me}
                            onAct={(a) => act(r, a)}
                            onDeclare={() => onDeclare([r.id])}
                            onResubmit={(seq) =>
                              post(
                                `/recordings/${r.id}/clips/${seq}/resubmit`,
                                undefined,
                                `Send clip ${seq} to Claru again as a NEW submission? Claru rejected the earlier one, which stays rejected.`,
                              )
                            }
                            onMockReview={(externalRef, decision, extra) =>
                              post('/admin/claru/mock/review', {
                                externalRef,
                                decision,
                                ...extra,
                              })
                            }
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
  me,
  onAct,
  onDeclare,
  onResubmit,
  onMockReview,
}: {
  r: RecordingView;
  me: PublicUser;
  onAct: (a: 'remove' | 'recheck' | 'retry-delivery') => void;
  onDeclare: () => void;
  onResubmit: (seq: number) => void;
  onMockReview: (
    externalRef: string,
    decision: 'approve' | 'reject',
    extra?: Record<string, string>,
  ) => void;
}) {
  const d = r.declaration;
  const subs = r.clips.map((c) => c.submission).filter(Boolean);
  // Once any clip is with Claru the declaration, the clips and the original are frozen.
  const withClaru = subs.some(
    (s) =>
      s &&
      ['draft', 'processing', 'in_review', 'approved', 'rejected'].includes(
        s.state,
      ),
  );
  const anyRefused = subs.some(
    (s) => s && (s.state === 'refused' || s.state === 'expired'),
  );
  const stuck = subs.some(
    (s) =>
      s &&
      ((s.lastError && (s.state === 'pending' || s.state === 'draft')) ||
        s.lost),
  );
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
        {r.checkStatus !== 'failed' && !withClaru && (
          <button className="link" onClick={onDeclare}>
            {d ? 'Change declaration' : 'Declare'}
          </button>
        )}
        {withClaru && (
          <p className="small muted">
            Sent to Claru: the declaration can no longer change.
          </p>
        )}
      </div>

      <div className="wide">
        <h3>Clips and Claru</h3>
        {r.splitError && <p className="small error">{r.splitError}</p>}
        {r.clips.length === 0 && <p className="small muted">No clips yet.</p>}
        {r.clips.length === 1 && (
          <p className="small muted">
            Up to 30 minutes: delivered as one clip, uncut.
          </p>
        )}
        {r.clips.map((c) => {
          const s = c.submission;
          const st = s ? DELIVERY[s.state] : null;
          return (
            <div key={c.seq} className="clip">
              <div>
                <strong>Clip {c.seq}</strong>{' '}
                <span className="small">
                  from {minutes(c.startSeconds)}, {minutes(c.durationSeconds)},{' '}
                  {size(c.sizeBytes)}
                </span>
                <div className="small mono muted">
                  {s?.externalRef ?? c.externalRef}
                </div>
              </div>
              <div className="small clip-status">
                {st ? (
                  <span className={`badge ${st.cls}`}>{st.text}</span>
                ) : (
                  <span className="muted">Not sent yet</span>
                )}
                {s && s.attempt > 1 && (
                  <span className="muted">
                    Attempt {s.attempt} (sent again after a rejection)
                  </span>
                )}
                {s?.overdue && <span className="error"> · review overdue</span>}
                {s?.sealedAt && (
                  <div className="muted">
                    Sealed {new Date(s.sealedAt).toLocaleString()}
                  </div>
                )}
                {s?.warnings.map((w) => (
                  <div key={w.code} className="muted">
                    Warning to Claru&apos;s reviewer: {w.code}
                  </div>
                ))}
                {s?.lastError &&
                  (s.state === 'pending' || s.state === 'draft') && (
                    <div className="error">
                      Not sent yet, retrying: {s.lastError}
                    </div>
                  )}
                {s?.lost && <div className="error">{s.lastError}</div>}
                {s?.refusal && s.state === 'refused' && (
                  <div className="error">
                    Refused at {s.refusal.stage} ({s.refusal.code}):{' '}
                    {s.refusal.remedy || s.refusal.message}
                  </div>
                )}
                {s?.rejection && s.state === 'rejected' && (
                  <div className="error">
                    Rejected by{' '}
                    {s.rejection.type === 'human'
                      ? 'a reviewer'
                      : 'an automatic check'}{' '}
                    ({s.rejection.code}): {s.rejection.reason}
                  </div>
                )}
                {s?.state === 'rejected' && (
                  <button className="link" onClick={() => onResubmit(c.seq)}>
                    Send again as a new submission
                  </button>
                )}
                {me.role === 'admin' &&
                  s &&
                  (s.state === 'processing' || s.state === 'in_review') && (
                    <span className="mock-controls">
                      Mock Claru:{' '}
                      <button
                        className="link"
                        onClick={() => onMockReview(s.externalRef, 'approve')}
                      >
                        approve
                      </button>
                      <button
                        className="link"
                        onClick={() =>
                          onMockReview(s.externalRef, 'reject', {
                            type: 'human',
                            reason:
                              'The task is not visible for most of the clip. (test)',
                          })
                        }
                      >
                        reject (reviewer)
                      </button>
                      <button
                        className="link"
                        onClick={() =>
                          onMockReview(s.externalRef, 'reject', {
                            type: 'machine',
                            code: 'QA_FROZEN',
                          })
                        }
                      >
                        reject (QA_FROZEN)
                      </button>
                    </span>
                  )}
              </div>
            </div>
          );
        })}
        {(anyRefused || stuck) && (
          <button className="link" onClick={() => onAct('retry-delivery')}>
            {anyRefused
              ? 'Retry delivery (same reference)'
              : 'Retry delivery now'}
          </button>
        )}
        {anyRefused && (
          <p className="small muted">
            Refused means Claru created nothing: fix what the code says (or the
            declaration), then retry under the same reference.
          </p>
        )}
      </div>

      <div className="row">
        {!withClaru &&
          (r.checkStatus === 'failed' ||
            r.splitStatus === 'failed' ||
            r.checkStatus === 'passed' ||
            r.checkStatus === 'warned') && (
            <button className="link" onClick={() => onAct('recheck')}>
              Check again
            </button>
          )}
        {!withClaru && (
          <button className="link danger" onClick={() => onAct('remove')}>
            Delete recording
          </button>
        )}
      </div>
    </div>
  );
}
