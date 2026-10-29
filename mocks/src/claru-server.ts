import { homedir } from 'node:os';
import { join } from 'node:path';
import { createMockClaru } from './claru.js';
import { loadRepoEnv } from './env.js';

loadRepoEnv();
const port = Number(process.env.MOCK_CLARU_PORT ?? 4010);
const apiKey = process.env.MOCK_CLARU_KEY ?? 'mock-claru-key';
const autoSeconds = Number(process.env.MOCK_CLARU_AUTO_APPROVE_SECONDS ?? 0);

createMockClaru({
  apiKey,
  processingSeconds: Number(process.env.MOCK_CLARU_PROCESSING_SECONDS ?? 20),
  // 0 = clips wait in review until you approve or reject them (Claru page, admin).
  autoReview: autoSeconds > 0 ? { decision: 'approve', afterSeconds: autoSeconds } : null,
  // Keeps submissions across restarts (every deploy restarts the mock).
  stateFile: process.env.MOCK_CLARU_STATE_FILE || join(homedir(), 'claru-dev-data', 'mock-claru-state.json'),
  // Only for trying short test videos locally; the project's real rule is 300–1800 s.
  ...(process.env.MOCK_CLARU_CLIP_MIN_SECONDS
    ? { clipLength: { minSeconds: Number(process.env.MOCK_CLARU_CLIP_MIN_SECONDS), maxSeconds: Number(process.env.MOCK_CLARU_CLIP_MAX_SECONDS ?? 1800) } }
    : {}),
  retryAfterSeconds: Number(process.env.MOCK_CLARU_RETRY_AFTER_SECONDS ?? 30),
}).listen(port, '127.0.0.1', () => {
  console.warn(`mock Claru on http://127.0.0.1:${port}/api/v1 (NOT the real Claru)`);
});
