import { createMockClaru } from './claru.js';
import { loadRepoEnv } from './env.js';

loadRepoEnv();
const port = Number(process.env.MOCK_CLARU_PORT ?? 4010);
const apiKey = process.env.MOCK_CLARU_KEY ?? 'mock-claru-key';

createMockClaru({ apiKey }).listen(port, '127.0.0.1', () => {
  console.warn(`mock Claru on http://127.0.0.1:${port}/api/v1 (NOT the real Claru)`);
});
