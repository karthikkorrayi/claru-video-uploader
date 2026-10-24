import { describe, expect, it } from 'vitest';
import { planClips } from '../src/media/plan.js';
import { assess, type PacketIndex, type ProbeResult } from '../src/media/probe.js';

const everySecond = (seconds: number) => Array.from({ length: seconds + 1 }, (_, i) => i);

describe('even split (Claru: 300–1800 s per clip)', () => {
  const plan = (minutes: number) => planClips(minutes * 60, everySecond(minutes * 60), 300, 1800);
  const lengths = (minutes: number) => {
    const p = plan(minutes);
    if (!p.ok) throw new Error(p.reason);
    return p.clips.map((c) => Math.round(c.duration));
  };

  it('keeps a recording of up to 30 minutes as one clip, uncut', () => {
    expect(lengths(25)).toEqual([1500]);
    expect(lengths(30)).toEqual([1800]);
  });

  it('cuts longer recordings into equal parts instead of dropping a tail', () => {
    expect(lengths(33)).toEqual([990, 990]);
    expect(lengths(70)).toEqual([1400, 1400, 1400]);
    expect(lengths(31)).toEqual([930, 930]); // 30 + 1 would have lost a minute
  });

  it('never makes a clip longer than the maximum or shorter than the minimum', () => {
    for (let m = 5; m <= 240; m += 1) {
      const p = plan(m);
      expect(p.ok).toBe(true);
      if (p.ok) for (const c of p.clips) expect(c.duration >= 300 && c.duration <= 1800).toBe(true);
    }
  });

  it('cuts only on keyframes, the last one at or before each ideal point', () => {
    const keys = [0, 7, 14, 21, 28, 35, 42, 49, 56, 63, 70];
    const p = planClips(70, keys, 10, 30);
    expect(p.ok && p.clips.map((c) => c.start)).toEqual([0, 21, 42]);
  });

  it('refuses a recording that is too short, and says why', () => {
    const p = planClips(299, everySecond(299), 300, 1800);
    expect(p).toEqual({ ok: false, reason: expect.stringMatching(/299 s.*minimum.*300/) });
  });

  it('refuses when keyframes are too sparse to cut inside the limits', () => {
    const p = planClips(3700, [0, 3000], 300, 1800);
    expect(p.ok).toBe(false);
  });
});

describe('checks on the probe result', () => {
  const rules = { minSeconds: 300, maxSeconds: 1800, aspect: '4_3' as const };
  const base = (): ProbeResult => ({
    format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '600', start_time: '0', tags: { major_brand: 'isom' } },
    streams: [
      { index: 0, codec_type: 'video', codec_name: 'hevc', width: 4000, height: 3000, avg_frame_rate: '30000/1001', color_transfer: 'bt709' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 3, codec_type: 'data', codec_tag_string: 'gpmd' },
    ],
  });
  const frames = (fps: number, seconds: number, keyEvery = 1): PacketIndex => {
    const pts = Array.from({ length: Math.round(fps * seconds) }, (_, i) => i / fps);
    return { pts, keyframes: pts.filter((_, i) => i % Math.round(fps * keyEvery) === 0) };
  };
  const codes = (p: ProbeResult, idx = frames(29.97, 600)) => assess(p, idx, rules, null).problems.map((x) => `${x.level}:${x.code}`);

  it('passes a clean GoPro-like file and finds its telemetry track', () => {
    const a = assess(base(), frames(29.97, 600), rules, null);
    expect(a.problems).toEqual([]);
    expect(a.telemetryStreamIndex).toBe(3);
    expect(a.media).toMatchObject({ width: 4000, height: 3000, hasAudio: true, hasTelemetry: true });
  });

  it('refuses PAL frame rates and says how to fix it on the camera', () => {
    const p = base();
    p.streams[0]!.avg_frame_rate = '25/1';
    const a = assess(p, frames(25, 600), rules, null);
    expect(a.problems.find((x) => x.code === 'FRAME_RATE')?.message).toMatch(/Anti-Flicker/);
  });

  it('refuses rotation, HDR, gaps over 100 ms and sparse keyframes', () => {
    const p = base();
    p.streams[0]!.side_data_list = [{ side_data_type: 'Display Matrix', rotation: -90 }];
    p.streams[0]!.color_transfer = 'arib-std-b67';
    const idx = frames(30, 600, 2);
    idx.pts.splice(100, 5); // a 200 ms hole
    expect(codes(p, idx)).toEqual(expect.arrayContaining(['error:ROTATION_TAG', 'error:HDR', 'error:FRAME_GAP', 'error:KEYFRAME_INTERVAL']));
  });

  it('warns, but accepts, 16:9 on a 4:3 project; refuses other shapes', () => {
    const wide = base();
    Object.assign(wide.streams[0]!, { width: 1920, height: 1080 });
    expect(codes(wide)).toEqual(['warn:ASPECT_RATIO']);
    const odd = base();
    Object.assign(odd.streams[0]!, { width: 1080, height: 1080 });
    expect(codes(odd)).toContain('error:ASPECT_RATIO');
  });

  it('finds location and author tags wherever they are', () => {
    const p = base();
    p.streams[1]!.tags = { 'com.apple.quicktime.location.ISO6709': '+17.38+078.48/' };
    p.format.tags = { ...p.format.tags, artist: 'x' };
    expect(codes(p)).toEqual(expect.arrayContaining(['error:LOCATION_PRESENT', 'error:AUTHOR_TAG_PRESENT']));
  });
});
