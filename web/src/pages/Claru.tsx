import { EmptyState, LoadingState } from '../components/UI.js';
import { useCallback, useEffect, useState } from 'react';
import type { ClaruOverview, DeliveryState } from '@cvu/shared';
import { api, errorText } from '../api.js';
import { DELIVERY } from './Recordings.js';

const ORDER: DeliveryState[] = [
  'pending',
  'draft',
  'processing',
  'in_review',
  'approved',
  'rejected',
  'refused',
  'expired',
];
const REFUSALS = [
  'FROZEN',
  'PADDED_FRAME_RATE',
  'FRAME_GAP',
  'LOCATION_PRESENT',
  'VIDEO_UNREADABLE',
  'DUPLICATE_CONTENT',
];

/**
 * Admin: everything about Claru in one place — how many clips are where, which
 * reviews are overdue (72 h after sealing, then every 6 h), and every call made.
 * On the test server, the mock Claru can be made to approve, reject or refuse.
 */
export function ClaruPage() {
  const [data, setData] = useState<ClaruOverview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refuse, setRefuse] = useState(REFUSALS[0]!);

  const load = useCallback(() => {
    api<ClaruOverview>('GET', '/admin/claru')
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function post(path: string, body: unknown, done: string) {
    try {
      await api('POST', path, body);
      setNotice(done);
      load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (!data) {
    return (
      <section className="card">
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : (
          <LoadingState label="Loading Claru deliveries…" />
        )}
      </section>
    );
  }
  const open = data.alerts.filter((a) => !a.resolvedAt);

  return (
    <>
      <section className="card">
        <div className="row spread">
          <h2>Deliveries</h2>
          <button
            className="link"
            onClick={() =>
              post(
                '/admin/claru/poll',
                {},
                'Asked Claru for the latest verdicts.',
              )
            }
          >
            Check Claru now
          </button>
        </div>
        {data.mock && (
          <p className="small notice-inline">
            Connected to the <strong>mock</strong> Claru on this server: nothing
            reaches the real Claru, and the test controls below are on.
          </p>
        )}
        <div className="counts">
          {ORDER.filter((s) => data.counts[s]).map((s) => (
            <div key={s} className="count">
              <div className={`n ${DELIVERY[s].cls}`}>{data.counts[s]}</div>
              <div className="small muted">{DELIVERY[s].text}</div>
            </div>
          ))}
          {data.lost > 0 && (
            <div className="count">
              <div className="n error">{data.lost}</div>
              <div className="small muted">
                Unknown to Claru: use Retry delivery
              </div>
            </div>
          )}
          {!Object.keys(data.counts).length && !data.lost && (
            <EmptyState title="No clips sent yet" icon="claru">
              Declared recordings are sent here automatically once checked and
              cut.
            </EmptyState>
          )}
        </div>
        {notice && <p className="small ok">{notice}</p>}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="card">
        <h2>
          Overdue reviews{' '}
          {open.length > 0 && (
            <span className="badge error">{open.length}</span>
          )}
        </h2>
        <p className="small muted">
          An alert opens {data.alertAfterHours} h after Claru accepted a clip
          without approving or rejecting it, with a reminder every{' '}
          {data.remindEveryHours} h. &quot;Seen&quot; records that you know;
          reminders continue until Claru decides. Closed alerts stay listed for
          7 days.
        </p>
        {data.alerts.length === 0 ? (
          <EmptyState title="No overdue reviews" icon="check" />
        ) : (
          <div
            className="table-scroll"
            role="region"
            aria-label="Overdue reviews"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  <th>Clip</th>
                  <th>Uploaded by</th>
                  <th>Waiting</th>
                  <th>Notices</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.alerts.map((a) => (
                  <tr key={a.id}>
                    <td className="small">
                      {a.filename}
                      <div className="mono muted">{a.externalRef}</div>
                    </td>
                    <td className="small">{a.uploader}</td>
                    <td className={a.resolvedAt ? 'small' : 'small error'}>
                      {a.hoursWaiting >= 1
                        ? `${a.hoursWaiting} h`
                        : `${Math.round(a.hoursWaiting * 60)} min`}
                    </td>
                    <td className="small">
                      {a.notifications}
                      {a.lastNotifiedAt && (
                        <div className="muted">
                          last {new Date(a.lastNotifiedAt).toLocaleString()}
                        </div>
                      )}
                    </td>
                    <td className="small">
                      {a.resolvedAt ? (
                        a.lost ? (
                          <span className="error">
                            Closed: unknown to Claru, send again
                          </span>
                        ) : (
                          <span className="ok">
                            Closed: {DELIVERY[a.state].text}
                          </span>
                        )
                      ) : (
                        DELIVERY[a.state].text
                      )}
                      {a.acknowledgedAt && (
                        <div className="muted">seen by {a.acknowledgedBy}</div>
                      )}
                    </td>
                    <td className="actions">
                      {!a.resolvedAt && !a.acknowledgedAt && (
                        <button
                          className="link"
                          onClick={() =>
                            post(
                              `/admin/claru/alerts/${a.id}/acknowledge`,
                              {},
                              'Marked as seen.',
                            )
                          }
                        >
                          Seen
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data.mock && (
        <section className="card">
          <h2>Test controls (mock Claru only)</h2>
          <p className="small muted">
            Approve or reject a clip from its Details on the Recordings page.
            Here: make the mock misbehave the way the real Claru can, to see how
            the app copes.
          </p>
          <div className="row wrap">
            <label>
              Refuse the next seal with
              <select
                value={refuse}
                onChange={(e) => setRefuse(e.target.value)}
              >
                {REFUSALS.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <button
              className="link"
              onClick={() =>
                post(
                  '/admin/claru/mock/faults',
                  { refuseNextSeal: refuse },
                  `The next seal will be refused with ${refuse}.`,
                )
              }
            >
              Arm
            </button>
            <button
              className="link"
              onClick={() =>
                post(
                  '/admin/claru/mock/faults',
                  { sealTimeouts: 1 },
                  'The next seal will time out once (503, Retry-After).',
                )
              }
            >
              Next seal times out
            </button>
            <button
              className="link"
              onClick={() =>
                post(
                  '/admin/claru/mock/faults',
                  { rateLimitNext: 3 },
                  'The next 3 calls get 429 Too Many Requests.',
                )
              }
            >
              Rate-limit next 3 calls
            </button>
            <button
              className="link"
              onClick={() =>
                post(
                  '/admin/claru/mock/faults',
                  { autoApproveSeconds: 120 },
                  'Clips in review are approved after 2 minutes.',
                )
              }
            >
              Auto-approve after 2 min
            </button>
            <button
              className="link"
              onClick={() =>
                post(
                  '/admin/claru/mock/faults',
                  {
                    autoApproveSeconds: 0,
                    refuseNextSeal: null,
                    sealTimeouts: 0,
                    rateLimitNext: 0,
                  },
                  'Test controls cleared.',
                )
              }
            >
              Clear all
            </button>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Calls to Claru</h2>
        <p className="small muted">
          Newest first, last 200 of 30 days. The API key and upload addresses
          are never recorded.
        </p>
        <div
          className="table-scroll"
          role="region"
          aria-label="Calls to Claru"
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Call</th>
                <th>Answer</th>
                <th>Time</th>
                <th>Clip</th>
              </tr>
            </thead>
            <tbody>
              {data.calls.map((c) => (
                <tr key={c.id}>
                  <td className="small nowrap">
                    {new Date(c.at).toLocaleTimeString()}
                  </td>
                  <td className="small mono">
                    {c.method} {c.path}
                    {c.note && <div className="muted">{c.note}</div>}
                  </td>
                  <td
                    className={`small ${c.status === 0 || c.status >= 400 ? 'error' : 'ok'}`}
                  >
                    {c.status === 0 ? 'no answer' : c.status}
                    {c.code ? ` ${c.code}` : ''}
                  </td>
                  <td className="small">{c.ms} ms</td>
                  <td className="small mono muted">{c.externalRef ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
