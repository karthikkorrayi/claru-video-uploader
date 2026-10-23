// npm run db:migrate -w @cvu/server   — applies pending migrations to DATABASE_URL.
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
try {
  const applied = await migrate(pool);
  console.warn(applied.length ? `Applied: ${applied.join(', ')}` : 'Database already up to date.');
} finally {
  await pool.end();
}
