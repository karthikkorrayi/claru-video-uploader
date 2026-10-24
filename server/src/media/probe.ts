import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CheckProblem, MediaSummary } from '@cvu/shared';

const run = promisify(execFile);

export interface MediaTools {
  ffprobe: string;
  ffmpeg: string;
}

/** What the checks hold a recording to: Claru's project rules (claru-integration.md). */
export interface ClipRules {
  minSeconds: number;
  maxSeconds: number;
  /** '4_3' or '16_9'. The other one of the two is accepted with a warning. */
  aspect: '4_3' | '16_9';
}

interface ProbeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  codec_tag_string?: string;
  width?: number;
  height?: number;
  sample_aspect_ratio?: string;
  avg_frame_rate?: string;
  color_transfer?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{ side_data_type?: string; rotation?: number }>;
}

export interface ProbeResult {
  format: { format_name?: string; duration?: string; start_time?: string; tags?: Record<string, string> };
  streams: ProbeStream[];
}

/** Video packet timestamps (seconds, file timeline) and which are keyframes. Read from the index, not decoded. */
export interface PacketIndex {
  pts: number[];
  keyframes: number[];
}

export interface Assessment {
  media: MediaSummary | null;
  problems: CheckProblem[];
  /** Keyframe times relative to the start of the file, for cutting. */
  keyframes: number[];
  startTime: number;
  telemetryStreamIndex: number | null;
}

const BIG = 64 * 1024 * 1024;

export async function probe(tools: MediaTools, path: string): Promise<ProbeResult> {
  const { stdout } = await run(tools.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], {
    maxBuffer: BIG,
  });
  return JSON.parse(stdout) as ProbeResult;
}

export async function readPacketIndex(tools: MediaTools, path: string): Promise<PacketIndex> {
  const { stdout } = await run(
    tools.ffprobe,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', path],
    { maxBuffer: BIG },
  );
  const pts: number[] = [];
  const keyframes: number[] = [];
  for (const line of stdout.split('\n')) {
    const [t, flags] = line.split(',');
    const v = Number(t);
    if (!t || t === 'N/A' || !Number.isFinite(v)) continue;
    pts.push(v);
    if (flags?.includes('K')) keyframes.push(v);
  }
  pts.sort((a, b) => a - b);
  keyframes.sort((a, b) => a - b);
  return { pts, keyframes };
}

/**
 * Reads every packet of the file without decoding it. Catches a truncated or
 * damaged container that the fingerprint (first and last 4 MB only) cannot see.
 * It does not decode the picture: a full decode of a 4 GB file costs many
 * CPU-minutes, and Claru decodes the stretches it doubts itself.
 */
export async function readThrough(tools: MediaTools, path: string): Promise<string | null> {
  try {
    const { stderr } = await run(tools.ffmpeg, ['-v', 'error', '-nostdin', '-i', path, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy', '-f', 'null', '-'], {
      maxBuffer: BIG,
    });
    return stderr.trim() ? stderr.trim().split('\n').slice(0, 3).join(' | ') : null;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    return (e.stderr || e.message).trim().split('\n').slice(0, 3).join(' | ');
  }
}

function ratio(s: string | undefined): number {
  if (!s) return NaN;
  const [a, b] = s.split(/[/:]/).map(Number);
  return b ? (a ?? NaN) / b : (a ?? NaN);
}

function allTags(p: ProbeResult): Array<[string, string]> {
  const out: Array<[string, string]> = Object.entries(p.format.tags ?? {});
  for (const s of p.streams) out.push(...Object.entries(s.tags ?? {}));
  return out;
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * The checks Claru runs at seal that we can run first (claru-integration.md,
 * "What we check when you seal"), so a recording that would be refused is
 * caught here, with a reason the consultant can act on. FROZEN and
 * PADDED_FRAME_RATE are Claru's own statistics and are left to Claru.
 */
export function assess(p: ProbeResult, idx: PacketIndex, rules: ClipRules, readError: string | null): Assessment {
  const problems: CheckProblem[] = [];
  const add = (level: CheckProblem['level'], code: string, message: string) => problems.push({ code, level, message });

  const video = p.streams.find((s) => s.codec_type === 'video');
  const audio = p.streams.find((s) => s.codec_type === 'audio');
  const telemetry = p.streams.find((s) => s.codec_type === 'data' && s.codec_tag_string === 'gpmd');
  const startTime = Number(p.format.start_time ?? 0) || 0;
  const duration = Number(p.format.duration);

  const majorBrand = (p.format.tags?.major_brand ?? '').trim();
  if (!(p.format.format_name ?? '').includes('mp4') || majorBrand === 'qt') {
    add('error', 'CONTAINER_NOT_MP4', `The file is a ${majorBrand === 'qt' ? 'QuickTime (.mov)' : (p.format.format_name ?? 'unknown')} file renamed to .mp4. Claru needs a real MP4.`);
  }
  if (readError) add('error', 'VIDEO_UNREADABLE', `The file could not be read to the end: ${readError}`);
  if (!video) {
    add('error', 'NO_VIDEO', 'The file has no video track.');
    return { media: null, problems, keyframes: [], startTime, telemetryStreamIndex: telemetry?.index ?? null };
  }

  const height = video.height ?? 0;
  const sar = ratio(video.sample_aspect_ratio);
  const width = Math.round((video.width ?? 0) * (Number.isFinite(sar) && sar > 0 ? sar : 1));
  const fps = ratio(video.avg_frame_rate);
  const keyframes = idx.keyframes.map((k) => round(k - startTime, 6));

  let maxKeyGap = 0;
  for (let i = 1; i < idx.keyframes.length; i++) maxKeyGap = Math.max(maxKeyGap, idx.keyframes[i]! - idx.keyframes[i - 1]!);
  let maxFrameGap = 0;
  for (let i = 1; i < idx.pts.length; i++) maxFrameGap = Math.max(maxFrameGap, idx.pts[i]! - idx.pts[i - 1]!);

  if (!['h264', 'hevc'].includes(video.codec_name ?? '')) {
    add('warn', 'CODEC', `Video codec is ${video.codec_name}; Claru's capture rules ask for H.264 or HEVC.`);
  }
  if (height < 1080) add('error', 'RESOLUTION_TOO_LOW', `Picture is ${height} pixels tall; Claru needs at least 1080.`);

  const ar = width / height;
  const is43 = Math.abs(ar - 4 / 3) < 0.02;
  const is169 = Math.abs(ar - 16 / 9) < 0.02;
  if (!is43 && !is169) {
    add('error', 'ASPECT_RATIO', `Picture shape is ${width}×${height}; Claru accepts only 4:3 or 16:9.`);
  } else if ((rules.aspect === '4_3' && is169) || (rules.aspect === '16_9' && is43)) {
    add('warn', 'ASPECT_RATIO', `Picture is ${is169 ? '16:9' : '4:3'}; this project asks for ${rules.aspect === '4_3' ? '4:3' : '16:9'}. Accepted by Claru with a warning to the reviewer.`);
  }

  if (!((fps >= 29.5 && fps <= 30.5) || (fps >= 59 && fps <= 61))) {
    const pal = Math.abs(fps - 25) < 0.6 || Math.abs(fps - 50) < 1 || Math.abs(fps - 100) < 1;
    add('error', 'FRAME_RATE', `Frame rate is ${round(fps, 2)} fps; Claru accepts only 29.97/30 or 59.94/60.${pal ? ' PAL rates are refused with no exception: set Anti-Flicker to 60Hz on the camera.' : ''}`);
  }
  // "A keyframe at least once a second", with half a frame of rounding allowance.
  if (idx.keyframes.length < 2 && duration > 1.5) {
    add('error', 'KEYFRAME_INTERVAL', 'The file has no regular keyframes; Claru needs one at least every second.');
  } else if (maxKeyGap > 1 + 0.5 / (fps || 30)) {
    add('error', 'KEYFRAME_INTERVAL', `Keyframes are up to ${round(maxKeyGap, 2)} s apart; Claru needs one at least every second.`);
  }
  if (maxFrameGap > 0.1) add('error', 'FRAME_GAP', `There is a ${Math.round(maxFrameGap * 1000)} ms gap between frames; Claru refuses gaps over 100 ms.`);

  const rotation = video.side_data_list?.find((d) => d.side_data_type === 'Display Matrix')?.rotation ?? Number(video.tags?.rotate ?? 0);
  if (rotation) add('error', 'ROTATION_TAG', `The video carries a ${rotation}° rotation tag; Claru refuses any rotation tag. Record with the camera upright.`);

  if (['smpte2084', 'arib-std-b67'].includes(video.color_transfer ?? '')) {
    add('error', 'HDR', `The video is HDR (${video.color_transfer}); Claru needs HDR off at capture.`);
  }

  const tags = allTags(p);
  const location = tags.find(([k]) => /location|iso6709/i.test(k));
  if (location) add('error', 'LOCATION_PRESENT', `The file carries a location (${location[0]}). Claru refuses it; turn location off on the camera.`);
  const author = tags.find(([k]) => /^(artist|author)$|quicktime\.(author|artist)/i.test(k));
  if (author) add('error', 'AUTHOR_TAG_PRESENT', `The file carries an ${author[0]} tag, a sign it went through an editor. Claru refuses it.`);

  if (!Number.isFinite(duration) || duration < rules.minSeconds) {
    add('error', 'CLIP_LENGTH', `The recording is ${Math.round(duration || 0)} s long; Claru needs at least ${rules.minSeconds} s, so there is nothing to deliver.`);
  }
  if (!audio) add('warn', 'NO_AUDIO', 'No audio track. Claru asks for audio to be recorded.');
  if (idx.keyframes.length >= 2 && maxKeyGap > 0 && idx.keyframes.length >= idx.pts.length * 0.9) {
    add('info', 'ALL_INTRA', 'Every frame is a keyframe, which usually means an editor export. Claru accepts it with a warning.');
  }

  return {
    media: {
      durationSeconds: round(duration || 0),
      width,
      height,
      fps: round(fps, 3),
      videoCodec: video.codec_name ?? 'unknown',
      hasAudio: !!audio,
      hasTelemetry: !!telemetry,
      maxKeyframeGapSeconds: round(maxKeyGap),
    },
    problems,
    keyframes,
    startTime,
    telemetryStreamIndex: telemetry?.index ?? null,
  };
}

export async function checkFile(tools: MediaTools, path: string, rules: ClipRules): Promise<Assessment> {
  let p: ProbeResult;
  let idx: PacketIndex;
  try {
    [p, idx] = await Promise.all([probe(tools, path), readPacketIndex(tools, path)]);
  } catch (err) {
    // ffprobe missing is our problem (retry, then CHECK_ERROR); anything else is the file's.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
    const detail = ((err as { stderr?: string }).stderr || (err as Error).message).trim().split('\n').slice(-2).join(' | ');
    return {
      media: null,
      problems: [{ code: 'VIDEO_UNREADABLE', level: 'error', message: `The file cannot be read as a video (${detail}). It may be incomplete; upload the original again.` }],
      keyframes: [],
      startTime: 0,
      telemetryStreamIndex: null,
    };
  }
  return assess(p, idx, rules, await readThrough(tools, path));
}
