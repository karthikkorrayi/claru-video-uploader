import type pg from 'pg';
import type { Logger } from 'pino';

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
}

export interface UploadContext {
  db: pg.Pool;
  logger: Logger;
  settings: UploadSettings;
}
