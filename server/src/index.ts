import { mkdirSync } from 'node:fs';
import { createApp } from './app.js';
import { cookieSecure, describeConfig, loadConfig, uploadSettings } from './config.js';
import { createPool } from './db.js';
import { createLogger } from './logger.js';
import { migrate } from './migrate.js';
import { startUploadSweeper } from './uploads/sweep.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

for (const dir of [config.WORK_DIR, config.TUS_DIR]) mkdirSync(dir, { recursive: true });

const pool = createPool(config.DATABASE_URL);

const applied = await migrate(pool);
if (applied.length) logger.info({ applied }, 'database migrations applied');

const app = createApp({
  pool,
  logger,
  sessionSecret: config.SESSION_SECRET,
  sessionHours: config.SESSION_HOURS,
  cookieSecure: cookieSecure(config),
  trustProxy: config.TRUST_PROXY,
  uploads: uploadSettings(config),
});

const stopSweeper = startUploadSweeper({ db: pool, logger, settings: uploadSettings(config) });

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
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
