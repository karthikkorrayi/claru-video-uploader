import { EmptyState, LoadingState } from '../components/UI.js';
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
