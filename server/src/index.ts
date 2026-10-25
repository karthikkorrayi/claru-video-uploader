import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createApp } from './app.js';
import { claruProjectSource } from './claru/project.js';
import { cookieSecure, describeConfig, loadConfig, uploadSettings } from './config.js';
import { createPool } from './db.js';
import { createLogger } from './logger.js';
import { createJobRunner } from './jobs.js';
import { migrate } from './migrate.js';
import { jobHandlers, onJobGiveUp, queueUncheckedRecordings } from './processing.js';
import { startUploadSweeper } from './uploads/sweep.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

for (const dir of [config.WORK_DIR, config.TUS_DIR]) mkdirSync(dir, { recursive: true });

const pool = createPool(config.DATABASE_URL);

const applied = await migrate(pool);
if (applied.length) logger.info({ applied }, 'database migrations applied');

const settings = uploadSettings(config);
for (const tool of [settings.tools.ffprobe, settings.tools.ffmpeg]) {
  try {
    execFileSync(tool, ['-version'], { stdio: 'ignore' });
  } catch {
    logger.error(`${tool} not found: recordings cannot be checked or cut until it is installed (brew install ffmpeg)`);
  }
}

const claru = claruProjectSource({ baseUrl: config.CLARU_BASE_URL, apiKey: config.CLARU_API_KEY, projectId: config.CLARU_PROJECT_ID });
// Our clip rules must match what Claru says today; a mismatch is logged, not fatal (Claru may be down at start).
claru
  .get()
  .then((p) => {
    const r = settings.clipRules;
    if (p.clipLength.minSeconds !== r.minSeconds || p.clipLength.maxSeconds !== r.maxSeconds || p.captureAspectRatio !== r.aspect) {
      logger.warn({ claru: { clipLength: p.clipLength, aspect: p.captureAspectRatio }, ours: r }, 'clip rules differ from Claru: update CLIP_* / CAPTURE_ASPECT in .env');
    }
  })
  .catch((err: unknown) => logger.warn({ err: (err as Error).message }, 'Claru project discovery failed at start-up'));

const app = createApp({
  pool,
  logger,
  sessionSecret: config.SESSION_SECRET,
  sessionHours: config.SESSION_HOURS,
  cookieSecure: cookieSecure(config),
  trustProxy: config.TRUST_PROXY,
  uploads: settings,
  claruProject: claru.get,
  environment: config.ENVIRONMENT_LABEL,
});

const core = { db: pool, logger, settings };
const stopSweeper = startUploadSweeper(core);
const queued = await queueUncheckedRecordings(core);
if (queued) logger.info({ queued }, 'queued checks for recordings received before phase L3');
const runner = createJobRunner({ db: pool, logger, handlers: jobHandlers(core), onGiveUp: onJobGiveUp(core), autoStart: true });

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info({ config: describeConfig(config) }, `server listening on http://${config.HOST}:${config.PORT}`);
});
// Upload chunks are up to 50 MB; on a slow connection one can take minutes.
// Node's default 5-minute request limit would cut them off.
server.requestTimeout = 30 * 60_000;
server.headersTimeout = 60_000;

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  logger.info(`${signal} received, shutting down`);
  stopSweeper();
  await runner.stop();
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
