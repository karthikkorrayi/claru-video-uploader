import { execFile } from 'node:child_process';
import { copyFile, link, rename, rm, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { PlannedClip } from './plan.js';
import { probe, type MediaTools } from './probe.js';

const run = promisify(execFile);

export interface CutClip {
  seq: number;
  path: string;
  start: number;
  duration: number;
  sizeBytes: number;
}

/**
 * Writes one clip with a stream copy, never re-encoding (claru-integration.md,
 * "Clip length and splitting" and "Splitting a GoPro file"):
 *   - the video, the audio if any, and a GoPro telemetry track (found by its
 *     `gpmd` codec tag, which works on HERO10–13) are mapped by name, because
 *     `-map 0` fails on the timecode track cameras add;
 *   - the start is a keyframe; 1 ms is added so rounding never makes ffmpeg
 *     fall back to the keyframe a second earlier.
 * A recording that is a single clip is hard-linked, not copied: no extra disk.
 */
export async function cutClip(
  tools: MediaTools,
  input: string,
  output: string,
  clip: PlannedClip,
  single: boolean,
  telemetryStreamIndex: number | null,
): Promise<CutClip> {
  const tmp = `${output}.part`;
  await rm(tmp, { force: true });
  await rm(output, { force: true });

  if (single) {
    try {
      await link(input, output);
    } catch {
      await copyFile(input, output);
    }
  } else {
    const args = ['-v', 'error', '-nostdin', '-y'];
    if (clip.start > 0) args.push('-ss', (clip.start + 0.001).toFixed(3));
    args.push('-i', input);
    if (clip.end !== null) args.push('-t', (clip.end - clip.start).toFixed(3));
    args.push('-map', '0:v:0', '-map', '0:a?');
    if (telemetryStreamIndex !== null) args.push('-map', `0:${telemetryStreamIndex}`);
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', '-f', 'mp4', tmp);
    await run(tools.ffmpeg, args, { maxBuffer: 16 * 1024 * 1024 });
    await rename(tmp, output);
  }

  const p = await probe(tools, output);
  const s = await stat(output);
  return { seq: clip.seq, path: output, start: clip.start, duration: Number(p.format.duration), sizeBytes: s.size };
}
