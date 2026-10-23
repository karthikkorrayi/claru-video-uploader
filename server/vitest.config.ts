import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests read TEST_DATABASE_URL from the repo's .env (never the dev database).
const envFile = resolve(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20_000,
    // All server tests share the claru_test database, so files run one at a time.
    fileParallelism: false,
  },
});
