import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real MP4s made with ffmpeg, cached between runs (about 15 s the first time).
const DIR = join(tmpdir(), 'cvu-fixtures-v1');

const RECIPES: Record<string, string[]> = {
  // 65 s, 1440×1080 (4:3), 30 fps, a keyframe every second, with audio: passes every check.
  good: [
    '-f', 'lavfi', '-i', 'testsrc2=size=1440x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '65', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '45', '-pix_fmt', 'yuv420p',
    '-x264-params', 'keyint=30:min-keyint=30:scenecut=0', '-c:a', 'aac', '-shortest',
  ],
  // 12 s, 1920×1080 (16:9): passes with a warning on a 4:3 project; one clip.
  wide: [
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
    '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '45', '-pix_fmt', 'yuv420p',
    '-x264-params', 'keyint=30:min-keyint=30:scenecut=0', '-c:a', 'aac', '-shortest',
  ],
  // 8 s, 720p, 25 fps (PAL), a keyframe every 3 s, no audio, location + artist tags, QuickTime container.
  bad: [
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '45',
    '-pix_fmt', 'yuv420p', '-x264-params', 'keyint=75:min-keyint=75:scenecut=0',
    '-metadata', 'location=+17.3850+078.4867/', '-metadata', 'artist=Some Editor', '-f', 'mov',
  ],
};

/** Returns the fixture's bytes, generating it on first use. */
export function fixture(name: keyof typeof RECIPES | 'truncated'): Buffer {
  mkdirSync(DIR, { recursive: true });
  const path = join(DIR, `${name}.mp4`);
  if (!existsSync(path)) {
    if (name === 'truncated') {
      const good = fixture('good');
      writeFileSync(path, good.subarray(0, Math.floor(good.length * 0.6)));
    } else {
      const recipe = RECIPES[name]!;
      const format = recipe.includes('mov') ? [] : ['-f', 'mp4'];
      execFileSync('ffmpeg', ['-v', 'error', '-y', ...recipe, ...format, `${path}.tmp`], { stdio: 'inherit' });
      renameSync(`${path}.tmp`, path);
    }
  }
  return readFileSync(path);
}
