import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Load the repo's .env for the mock servers (not used by tests). */
export function loadRepoEnv(): void {
  const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}
