export interface PlannedClip {
  seq: number;
  /** Seconds from the start of the recording; always a keyframe. */
  start: number;
  /** Null for the last clip: it runs to the end of the recording. */
  end: number | null;
  duration: number;
}

export type Plan = { ok: true; clips: PlannedClip[] } | { ok: false; reason: string };

/**
 * Even split (decided 2026-10-25): the fewest clips that each fit Claru's
 * length range, cut as close to equal as the keyframes allow. Nothing is
 * dropped unless the whole recording is shorter than the minimum.
 *
 *   25 min → 1 clip (no cutting at all)
 *   33 min → 2 × 16.5 min
 *   70 min → 3 × 23.3 min
 *
 * Cuts land on the last keyframe at or before each ideal point, because a
 * stream copy can only start a clip on a keyframe. With a keyframe at least
 * every second, a clip is at most about a second longer than the ideal, so the
 * target leaves a 2-second margin under the maximum.
 */
export function planClips(duration: number, keyframes: number[], min: number, max: number): Plan {
  if (!(duration > 0)) return { ok: false, reason: 'The recording has no duration.' };
  if (duration < min) return { ok: false, reason: `The recording is ${Math.round(duration)} s; the minimum clip is ${min} s.` };
  if (duration <= max) return { ok: true, clips: [{ seq: 1, start: 0, end: null, duration }] };

  const n = Math.ceil(duration / (max - 2));
  const cuts: number[] = [0];
  for (let i = 1; i < n; i++) {
    const ideal = (duration * i) / n;
    const previous = cuts[cuts.length - 1]!;
    let best: number | undefined;
    for (const k of keyframes) {
      if (k > ideal) break;
      if (k > previous) best = k;
    }
    if (best === undefined) return { ok: false, reason: `No keyframe before ${Math.round(ideal)} s to cut at.` };
    cuts.push(best);
  }

  const clips: PlannedClip[] = cuts.map((start, i) => {
    const end = i + 1 < cuts.length ? cuts[i + 1]! : null;
    return { seq: i + 1, start, end, duration: (end ?? duration) - start };
  });
  const bad = clips.find((c) => c.duration < min || c.duration > max);
  if (bad) {
    return { ok: false, reason: `Clip ${bad.seq} would be ${Math.round(bad.duration)} s, outside ${min}–${max} s (keyframes too far apart).` };
  }
  return { ok: true, clips };
}
