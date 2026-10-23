import { loadRepoEnv } from './env.js';
import { createMockGraph } from './graph.js';

loadRepoEnv();
const port = Number(process.env.MOCK_GRAPH_PORT ?? 4020);

createMockGraph().listen(port, '127.0.0.1', () => {
  console.warn(`mock Microsoft Graph on http://127.0.0.1:${port} (NOT the real OneDrive)`);
});
