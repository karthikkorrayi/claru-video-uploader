import type pg from 'pg';
import type { Logger } from 'pino';
import type { ClaruProjectView } from '@cvu/shared';
import type { ClipRules, MediaTools } from '../media/probe.js';

export interface UploadSettings {
  /** Partial uploads (tus). Same disk as workDir, so finishing an upload is a rename. */
  tusDir: string;
  /** Received originals, one folder per recording. */
  workDir: string;
  maxUploadBytes: number;
  /** Free space always left on the disk, on top of what uploads need. */
  diskReserveBytes: number;
  /** An upload with no new bytes for this long is given up and its partial file deleted. */
  abandonAfterHours: number;
  /** ffprobe / ffmpeg commands (phase L3). */
  tools: MediaTools;
  /** Claru's clip rules for the project (phase L3). */
  clipRules: ClipRules;
}

export interface UploadContext {
  db: pg.Pool;
  logger: Logger;
  settings: UploadSettings;
  /** Claru's project (categories for the declaration form). Cached; throws if Claru cannot be reached. */
  claruProject: () => Promise<ClaruProjectView>;
}
