import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMockClaru, MOCK_PROJECT } from '../src/claru.js';

interface ProjectsResponse {
  team: { status: string };
  contract: { version: number; minAcceptedVersion: number };
  rateLimit: { requestsPerMinute: number };
  projects: Array<{ id: string; clipLength: { minSeconds: number; maxSeconds: number }; checkGroups: { imu: string } }>;
}

let server: Server;
let base = '';

beforeAll(async () => {
  server = createMockClaru({ apiKey: 'test-key' }).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

describe('mock Claru discovery', () => {
  it('rejects a missing key with a plain 401', async () => {
    const res = await fetch(`${base}/api/v1/supplier/projects`);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ statusCode: 401, message: 'Unauthorized' });
  });

  it('lists the project from the guide with the right key', async () => {
    const res = await fetch(`${base}/api/v1/supplier/projects`, { headers: { 'x-api-key': 'test-key' } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectsResponse;
    const project = body.projects[0];
    expect(body.team.status).toBe('active');
    expect(body.contract).toEqual({ version: 2, minAcceptedVersion: 1 });
    expect(body.rateLimit.requestsPerMinute).toBe(600);
    expect(project?.id).toBe(MOCK_PROJECT.id);
    expect(project?.clipLength).toEqual({ minSeconds: 300, maxSeconds: 1800 });
    expect(project?.checkGroups.imu).toBe('off');
  });
});
