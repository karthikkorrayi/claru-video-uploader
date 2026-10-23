// Creates the first (or another) admin account. There is deliberately no web page for this.
//
//   printf '%s' "$PASSWORD" | npm run admin:create -w @cvu/server -- --username kk --display-name "Karthik" --password-stdin
//
// The password is read from standard input so it never appears in shell history or `ps`.
import { audit } from '../src/audit.js';
import { hashPassword, passwordProblem } from '../src/auth/password.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { findUserByUsername, insertUser, USERNAME_PATTERN } from '../src/users.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const username = (arg('username') ?? '').trim().toLowerCase();
const displayName = (arg('display-name') ?? '').trim();
if (!USERNAME_PATTERN.test(username)) fail('--username: 2–32 lowercase letters, digits, dot, dash or underscore.');
if (!displayName || displayName.length > 80) fail('--display-name: 1–80 characters.');
if (!process.argv.includes('--password-stdin')) fail('Pass the password on standard input with --password-stdin.');

const password = await readStdin();
const problem = passwordProblem(password, username);
if (problem) fail(`Password not accepted: ${problem}`);

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
try {
  await migrate(pool);
  if (await findUserByUsername(pool, username)) fail(`A user named "${username}" already exists.`);
  const user = await insertUser(pool, {
    username,
    displayName,
    role: 'admin',
    passwordHash: await hashPassword(password),
    mustChangePassword: false,
  });
  await audit(pool, { action: 'admin_created', targetType: 'user', targetId: user.id, details: { username, via: 'cli' } });
  console.warn(`✓ Admin "${username}" created.`);
} finally {
  await pool.end();
}
