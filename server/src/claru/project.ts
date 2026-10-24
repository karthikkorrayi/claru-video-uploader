import type { ClaruProjectView } from '@cvu/shared';

interface ProjectsResponse {
  team?: { status?: string; blocked?: { code?: string; remedy?: string } };
  projects?: Array<{
    id: string;
    name: string;
    captureAspectRatio?: string;
    clipLength?: { minSeconds: number; maxSeconds: number };
    categories?: Array<{ code: string; name: string; parent?: { name?: string } | null }>;
  }>;
}

export class ClaruUnavailableError extends Error {}

/**
 * Discovery (claru-integration.md, "1. Discover"): GET /supplier/projects is
 * the only source of category codes, which change. Read once and cached for
 * ten minutes; `refresh` forces a new read (L4 uses it on CATEGORY_UNKNOWN).
 * The API key goes only in the x-api-key header and never into a log or error.
 */
export function claruProjectSource(opts: {
  baseUrl: string;
  apiKey: string;
  projectId: string;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
}): { get: () => Promise<ClaruProjectView>; refresh: () => Promise<ClaruProjectView> } {
  const ttl = opts.ttlMs ?? 10 * 60_000;
  const doFetch = opts.fetchImpl ?? fetch;
  let cached: { at: number; value: ClaruProjectView } | null = null;

  async function load(): Promise<ClaruProjectView> {
    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}/supplier/projects`, {
        headers: { 'x-api-key': opts.apiKey },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new ClaruUnavailableError(`Claru could not be reached (${(err as Error).name}).`);
    }
    if (res.status === 401) throw new ClaruUnavailableError('Claru refused the API key (401). Check CLARU_API_KEY.');
    if (!res.ok) throw new ClaruUnavailableError(`Claru answered ${res.status} to project discovery.`);
    const body = (await res.json()) as ProjectsResponse;
    if (body.team?.blocked) {
      throw new ClaruUnavailableError(`Claru has blocked the team: ${body.team.blocked.code ?? ''} ${body.team.blocked.remedy ?? ''}`.trim());
    }
    const p = body.projects?.find((x) => x.id === opts.projectId);
    if (!p) throw new ClaruUnavailableError(`Project ${opts.projectId} is not in Claru's project list for this key.`);
    const value: ClaruProjectView = {
      id: p.id,
      name: p.name,
      captureAspectRatio: p.captureAspectRatio ?? '4_3',
      clipLength: p.clipLength ?? { minSeconds: 300, maxSeconds: 1800 },
      categories: (p.categories ?? []).map((c) => ({ code: c.code, name: c.name, parent: c.parent?.name ?? null })),
    };
    cached = { at: Date.now(), value };
    return value;
  }

  return {
    get: async () => (cached && Date.now() - cached.at < ttl ? cached.value : load()),
    refresh: load,
  };
}
