import { useEffect, useRef, useState } from 'react';
import Uppy, { type Meta, type UppyFile } from '@uppy/core';
import Dashboard from '@uppy/dashboard';
import Tus from '@uppy/tus';
import '@uppy/core/css/style.min.css';
import '@uppy/dashboard/css/style.min.css';
import { fingerprintFromSamples, fingerprintRanges, type RecordingView } from '@cvu/shared';
import { api, errorText } from '../api.js';

type FileMeta = Meta & { recordingId?: string };
type Body = Record<string, never>;

interface Problem {
  name: string;
  message: string;
}

const CHUNK_BYTES = 50 * 1024 * 1024;
// Keep retrying for about 10 minutes (Wi-Fi drops, server restarts); after
// that the file shows a retry button, and coming back online retries anyway.
const RETRY_DELAYS = [0, 1000, 3000, 5000, 10000, 20000, 30000, 60000, 60000, 60000, 60000, 60000, 60000, 60000, 60000];

async function fingerprintOf(file: Blob): Promise<string> {
  const { head, tail } = fingerprintRanges(file.size);
  const read = async ([a, b]: [number, number]) => new Uint8Array(await file.slice(a, b).arrayBuffer());
  return fingerprintFromSamples(file.size, await read(head), await read(tail));
}

/**
 * Uploads with Uppy + tus. Before any bytes move, each file is declared to the
 * server (name, size, fingerprint). The server answers with a recording id,
 * which is also the upload's address — so the same file added again later, in
 * any browser, continues from where the server says it stopped.
 */
export function UploadPage({ onUploaded }: { onUploaded: () => void }) {
  const target = useRef<HTMLDivElement>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [busy, setBusy] = useState(false);
  const notify = useRef(onUploaded);
  notify.current = onUploaded;

  useEffect(() => {
    const uppy = new Uppy<FileMeta, Body>({
      autoProceed: false,
      restrictions: { allowedFileTypes: ['.mp4', 'video/mp4'] },
    });

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
        if (!file || file.meta.recordingId || !(file.data instanceof Blob)) continue;
        uppy.emit('preprocess-progress', file, { mode: 'indeterminate', message: 'Checking file…' });
        try {
          const fingerprint = await fingerprintOf(file.data);
          const r = await api<{ recording: RecordingView; resumed: boolean }>('POST', '/recordings', {
            filename: file.name,
            sizeBytes: file.size,
            fingerprint,
          });
          uppy.setFileMeta(id, { recordingId: r.recording.id });
          // HEAD on this address tells tus how much the server already has (nothing → it starts the upload).
          uppy.setFileState(id, { tus: { uploadUrl: `/api/uploads/${r.recording.id}` } });
          uppy.emit('preprocess-complete', uppy.getFile(id));
        } catch (err) {
          setProblems((p) => [...p, { name: file.name ?? 'file', message: errorText(err) }]);
          uppy.removeFile(id);
        }
      }
    });

    uppy.on('upload', () => setBusy(true));
    uppy.on('complete', () => setBusy(false));
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
      if (/does not match|cancelled|not found/i.test(text)) {
        setProblems((p) => [...p, { name: file?.name ?? 'file', message: text.replace(/^.*response text: /s, '').split(', request id')[0] ?? text }]);
      }
    });
    // Uppy notices the network coming back; resume everything that gave up meanwhile.
    uppy.on('back-online', () => void uppy.retryAll());

    const warn = (e: BeforeUnloadEvent) => {
      const uploading = uppy.getFiles().some((f) => f.progress.uploadStarted && !f.progress.uploadComplete);
      if (uploading) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);

    return () => {
      window.removeEventListener('beforeunload', warn);
      uppy.destroy();
    };
  }, []);

  return (
    <>
      <section className="card">
        <h1>Upload recordings</h1>
        <p className="small muted">
          Add one or more MP4 files and press Upload. Each file is checked against the server first, so the same recording is never
          uploaded twice.
        </p>
        <details className="small">
          <summary>If the upload is interrupted</summary>
          <ul>
            <li>Wi-Fi drops or the server restarts: it keeps retrying on its own and continues where it stopped.</li>
            <li>
              You closed the tab or the laptop: open this page again, add the <strong>same file</strong> and press Upload. Only the
              missing part is sent.
            </li>
            <li>Nothing arrives for 72 hours: the partial upload is deleted and you start again.</li>
          </ul>
        </details>
        {busy && <p className="small notice-inline">Uploading — keep this tab open. You can use the other pages meanwhile.</p>}
      </section>

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
