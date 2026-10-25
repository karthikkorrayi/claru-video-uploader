import { useCallback, useEffect, useRef, useState } from 'react';
import Uppy, { type Meta, type UppyFile } from '@uppy/core';
import Dashboard from '@uppy/dashboard';
import Tus from '@uppy/tus';
import '@uppy/core/css/style.min.css';
import '@uppy/dashboard/css/style.min.css';
import {
  fingerprintFromSamples,
  fingerprintRanges,
  type PublicUser,
  type RecordingView,
} from '@cvu/shared';
import { api, errorText } from '../api.js';
import { reportProblem } from '../reporter.js';
import type { Theme } from '../theme.js';
import { size } from './Recordings.js';

type FileMeta = Meta & { recordingId?: string };
type Body = Record<string, never>;

interface Problem {
  name: string;
  message: string;
}

const CHUNK_BYTES = 50 * 1024 * 1024;
// Keep retrying for about 10 minutes (Wi-Fi drops, server restarts); after
// that the file shows a retry button, and coming back online retries anyway.
const RETRY_DELAYS = [
  0, 1000, 3000, 5000, 10000, 20000, 30000, 60000, 60000, 60000, 60000, 60000,
  60000, 60000, 60000,
];

async function fingerprintOf(file: Blob): Promise<string> {
  const { head, tail } = fingerprintRanges(file.size);
  const read = async ([a, b]: [number, number]) =>
    new Uint8Array(await file.slice(a, b).arrayBuffer());
  return fingerprintFromSamples(file.size, await read(head), await read(tail));
}

/**
 * Uploads with Uppy + tus. Before any bytes move, each file is declared to the
 * server (name, size, fingerprint). The server answers with a recording id,
 * which is also the upload's address — so the same file added again later, in
 * any browser, continues from where the server says it stopped.
 */
export function UploadPage({
  me,
  onUploaded,
  theme,
}: {
  me: PublicUser;
  onUploaded: () => void;
  theme: Theme;
}) {
  const target = useRef<HTMLDivElement>(null);
  const uppyRef = useRef<Uppy<FileMeta, Body> | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [busy, setBusy] = useState(false);
  const [unfinished, setUnfinished] = useState<RecordingView[]>([]);
  const notify = useRef(onUploaded);
  notify.current = onUploaded;

  /**
   * Your uploads the server is still waiting for, that this tab is not sending.
   * A browser cannot reopen a file by itself after a reload or a closed tab,
   * so these need you to add the same file again.
   */
  const loadUnfinished = useCallback(() => {
    api<{ recordings: RecordingView[] }>('GET', '/recordings')
      .then((r) => {
        const inThisTab = new Set(
          uppyRef.current?.getFiles().map((f) => f.meta.recordingId) ?? [],
        );
        setUnfinished(
          r.recordings.filter(
            (x) =>
              x.uploadedBy.id === me.id &&
              (x.transferStatus === 'waiting' ||
                x.transferStatus === 'receiving') &&
              !inThisTab.has(x.id),
          ),
        );
      })
      .catch(() => undefined);
  }, [me.id]);

  useEffect(() => {
    const uppy = new Uppy<FileMeta, Body>({
      autoProceed: false,
      restrictions: { allowedFileTypes: ['.mp4', 'video/mp4'] },
    });
    uppyRef.current = uppy;

    uppy.use(Dashboard, {
      target: target.current!,
      inline: true,
      width: '100%',
      height: 440,
      theme: 'auto',
      proudlyDisplayPoweredByUppy: false,
      note: 'MP4 files only. Two files upload at a time; the rest wait their turn.',
    });

    uppy.use(Tus, {
      endpoint: '/api/uploads',
      headers: { 'X-Requested-With': 'cvu' },
      chunkSize: CHUNK_BYTES,
      limit: 2,
      retryDelays: RETRY_DELAYS,
      allowedMetaFields: ['recordingId'],
      // The resume address comes from the server (see below), not from browser storage.
      storeFingerprintForResuming: false,
    });

    uppy.addPreProcessor(async (fileIDs) => {
      for (const id of fileIDs) {
        const file = uppy.getFile(id) as UppyFile<FileMeta, Body> | undefined;
        if (!file || file.meta.recordingId || !(file.data instanceof Blob))
          continue;
        uppy.emit('preprocess-progress', file, {
          mode: 'indeterminate',
          message: 'Checking file…',
        });
        try {
          const fingerprint = await fingerprintOf(file.data);
          const r = await api<{ recording: RecordingView; resumed: boolean }>(
            'POST',
            '/recordings',
            {
              filename: file.name,
              sizeBytes: file.size,
              fingerprint,
            },
          );
          uppy.setFileMeta(id, { recordingId: r.recording.id });
          if (r.resumed && r.recording.transferStatus === 'receiving') {
            // Interrupted earlier (tab closed, page reloaded, other browser): ask the server
            // how much it already has and send only the rest.
            uppy.setFileState(id, {
              tus: { uploadUrl: `/api/uploads/${r.recording.id}` },
            });
          }
          uppy.emit('preprocess-complete', uppy.getFile(id));
        } catch (err) {
          setProblems((p) => [
            ...p,
            { name: file.name ?? 'file', message: errorText(err) },
          ]);
          uppy.removeFile(id);
        }
      }
    });

    uppy.on('upload', () => setBusy(true));
    uppy.on('complete', () => {
      setBusy(false);
      loadUnfinished();
    });
    uppy.on('upload-start', () => loadUnfinished());
    uppy.on('file-removed', () => loadUnfinished());
    uppy.on('upload-success', (file) => {
      notify.current();
      // Clear finished files after a moment so the drop area is ready for the next batch.
      if (file) {
        setTimeout(() => {
          if (uppy.getFile(file.id)) uppy.removeFile(file.id);
        }, 4000);
      }
    });
    uppy.on('upload-error', (file, error) => {
      const text = String(error?.message ?? error);
      reportProblem({
        kind: 'upload',
        message: `${file?.name ?? 'file'}: ${text}`.slice(0, 1000),
      });
      if (/does not match|cancelled|not found/i.test(text)) {
        setProblems((p) => [
          ...p,
          {
            name: file?.name ?? 'file',
            message:
              text
                .replace(/^.*response text: /s, '')
                .split(', request id')[0] ?? text,
          },
        ]);
      }
    });
    // Uppy notices the network coming back; resume everything that gave up meanwhile.
    uppy.on('back-online', () => void uppy.retryAll());

    const warn = (e: BeforeUnloadEvent) => {
      const uploading = uppy
        .getFiles()
        .some((f) => f.progress.uploadStarted && !f.progress.uploadComplete);
      if (uploading) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    loadUnfinished();
    const timer = setInterval(loadUnfinished, 15000);

    return () => {
      clearInterval(timer);
      window.removeEventListener('beforeunload', warn);
      uppyRef.current = null;
      uppy.destroy();
    };
  }, [loadUnfinished]);

  useEffect(() => {
    uppyRef.current
      ?.getPlugin<Dashboard<FileMeta, Body>>('Dashboard')
      ?.setOptions({ theme });
  }, [theme]);

  return (
    <>
      <section className="card">
        <h2>Add your footage</h2>
        <p className="small muted">
          Add one or more MP4 files and press Upload. Each file is checked
          against the server first, so the same recording is never uploaded
          twice.
        </p>
        <details className="small">
          <summary>If the upload is interrupted</summary>
          <ul>
            <li>
              Wi-Fi drops or the server restarts: it keeps retrying on its own
              and continues where it stopped.
            </li>
            <li>
              The tab was closed or reloaded: the browser cannot pick the file
              up again by itself. Open this page, add the{' '}
              <strong>same file</strong> and press Upload. Only the missing part
              is sent.
            </li>
            <li>
              Nothing arrives for 72 hours: the partial upload is deleted and
              you start again.
            </li>
          </ul>
        </details>
        {busy && (
          <p className="small notice-inline">
            Uploading — keep this tab open. You can use the other pages
            meanwhile.
          </p>
        )}
      </section>

      {unfinished.length > 0 && (
        <section className="card notice" role="status">
          <h2>Unfinished uploads</h2>
          <p className="small">
            The server is waiting for the rest of these. Add the same file below
            and press Upload to continue.
          </p>
          <ul className="small">
            {unfinished.map((r) => (
              <li key={r.id}>
                <strong>{r.originalFilename}</strong> — {size(r.receivedBytes)}{' '}
                of {size(r.sizeBytes)} received (
                {Math.floor((r.receivedBytes / r.sizeBytes) * 100)}%)
              </li>
            ))}
          </ul>
        </section>
      )}

      {problems.length > 0 && (
        <section className="card notice" role="alert">
          <h2>Not uploaded</h2>
          <ul className="small">
            {problems.map((p, i) => (
              <li key={i}>
                <strong>{p.name}</strong>: {p.message}
              </li>
            ))}
          </ul>
          <button className="link" onClick={() => setProblems([])}>
            Clear
          </button>
        </section>
      )}

      <div ref={target} />
    </>
  );
}
