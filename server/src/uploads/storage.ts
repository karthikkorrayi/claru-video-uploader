import { copyFile, mkdir, open, rename, rm, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fingerprintFromSamples, fingerprintRanges } from '@cvu/shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Every path below is built from a recording id; refuse anything that is not one, so no path can escape its folder. */
function checkId(id: string): string {
  if (!UUID.test(id)) throw new Error(`not a recording id: ${id}`);
  return id;
}

/** Where tus keeps a partial upload. @tus/file-store names the file after the upload id (our recording id). */
export function tusFilePath(tusDir: string, id: string): string {
  return join(tusDir, checkId(id));
}

/** A received recording's folder in the working area; later phases put its clips beside the original. */
export function recordingDir(workDir: string, id: string): string {
  return join(workDir, checkId(id));
}

export function originalPath(workDir: string, id: string): string {
  return join(recordingDir(workDir, id), 'original.mp4');
}

/** Free bytes available to this (non-root) process on the disk holding `dir`. */
export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

/** Deletes a partial upload and its tus metadata file. Missing files are fine. */
export async function removeTusFiles(tusDir: string, id: string): Promise<void> {
  const base = tusFilePath(tusDir, id);
  await Promise.all([unlink(base).catch(ignoreMissing), unlink(`${base}.json`).catch(ignoreMissing)]);
}

export async function removeRecordingDir(workDir: string, id: string): Promise<void> {
  await rm(recordingDir(workDir, id), { recursive: true, force: true });
}

/**
 * Moves a finished upload into WORK_DIR/<id>/original.mp4. A rename is instant
 * when both folders are on the same disk (the normal setup); otherwise copy, then delete.
 */
export async function moveToWorkDir(tusDir: string, workDir: string, id: string): Promise<string> {
  const from = tusFilePath(tusDir, id);
  const to = originalPath(workDir, id);
  await mkdir(recordingDir(workDir, id), { recursive: true });
  try {
    await rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await unlink(from);
  }
  await unlink(`${from}.json`).catch(ignoreMissing);
  return to;
}

/** Recomputes the browser's fingerprint (see @cvu/shared) from a file on disk. */
export async function fingerprintOfFile(path: string, size: number): Promise<string> {
  const { head, tail } = fingerprintRanges(size);
  const fh = await open(path, 'r');
  try {
    const read = async ([start, end]: [number, number]) => {
      const buf = Buffer.alloc(end - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    };
    return await fingerprintFromSamples(size, await read(head), await read(tail));
  } finally {
    await fh.close();
  }
}

function ignoreMissing(err: NodeJS.ErrnoException): void {
  if (err.code !== 'ENOENT') throw err;
}
