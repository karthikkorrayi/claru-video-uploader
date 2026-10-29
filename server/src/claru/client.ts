/**
 * Claru's supplier API (claru-integration.md, contract v2): one place for
 * every call, so the rules are written once —
 *   - the key goes only in the x-api-key header, never in a log or an error;
 *   - 429 and 503 are retried after EXACTLY the Retry-After the server sends
 *     ("not advisory"); other 5xx and network errors back off and retry;
 *   - 4xx answers (refusals, 404) are returned to the caller, not retried;
 *   - uploads go straight to storage with no key, never with a checksum header.
 */
export interface ClaruCall {
  method: string;
  path: string;
  status: number;
  code: string | null;
  ms: number;
  externalRef: string | null;
  note: string | null;
}

export interface ClaruAnswer<T = Record<string, unknown>> {
  status: number;
  body: T;
  retryAfter: number | null;
}

export class ClaruUnreachable extends Error {}

export interface ClaruClientOptions {
  baseUrl: string;
  apiKey: string;
  projectId: string;
  contractVersion: number;
  onCall?: (c: ClaruCall) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  /** Never wait longer than this on one Retry-After (seconds). */
  maxRetryAfterSeconds?: number;
}

export interface ClaruClient {
  readonly projectId: string;
  readonly contractVersion: number;
  call<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, externalRef?: string | null): Promise<ClaruAnswer<T>>;
  /** PUT bytes to a presigned URL; returns the ETag. Headers are sent exactly as Claru gave them. */
  putBytes(url: string, data: Uint8Array, headers: Record<string, string>, label: string, externalRef: string | null): Promise<string | null>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createClaruClient(o: ClaruClientOptions): ClaruClient {
  const doFetch = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? realSleep;
  const maxAttempts = o.maxAttempts ?? 6;
  const capRetryAfter = o.maxRetryAfterSeconds ?? 120;
  const log = (c: ClaruCall) => o.onCall?.(c);

  function retryAfterOf(res: Response, body: Record<string, unknown>): number | null {
    const h = Number(res.headers.get('retry-after'));
    if (Number.isFinite(h) && h >= 0) return h;
    const d = Number((body.details as Record<string, unknown> | undefined)?.retryAfterSeconds);
    return Number.isFinite(d) ? d : null;
  }

  return {
    projectId: o.projectId,
    contractVersion: o.contractVersion,

    async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, externalRef: string | null = null) {
      let lastProblem = '';
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const started = Date.now();
        let res: Response;
        try {
          res = await doFetch(`${o.baseUrl}${path}`, {
            method,
            headers: { 'x-api-key': o.apiKey, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
            // Seal has a 30-second budget that a slow phase can overrun: wait generously.
            signal: AbortSignal.timeout(path.endsWith('/seal') ? 120_000 : 60_000),
          });
        } catch (err) {
          lastProblem = (err as Error).name;
          log({ method, path, status: 0, code: null, ms: Date.now() - started, externalRef, note: `network: ${lastProblem}` });
          await sleep(Math.min(2 ** attempt, 30) * 1000);
          continue;
        }
        const text = await res.text();
        let parsed: Record<string, unknown> = {};
        try {
          parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
          parsed = { message: text.slice(0, 200) };
        }
        const code = typeof parsed.code === 'string' ? parsed.code : null;
        const retryAfter = retryAfterOf(res, parsed);
        log({ method, path, status: res.status, code, ms: Date.now() - started, externalRef, note: retryAfter !== null && res.status >= 429 ? `Retry-After ${retryAfter}` : null });

        if (res.status === 429 || res.status === 503) {
          lastProblem = `${res.status}${code ? ` ${code}` : ''}`;
          await sleep(Math.min(retryAfter ?? 2 ** attempt, capRetryAfter) * 1000);
          continue;
        }
        if (res.status >= 500) {
          lastProblem = String(res.status);
          await sleep(Math.min(2 ** attempt, 30) * 1000);
          continue;
        }
        return { status: res.status, body: parsed as T, retryAfter };
      }
      throw new ClaruUnreachable(`Claru ${method} ${path} kept failing (${lastProblem || 'no answer'}) after ${maxAttempts} tries`);
    },

    async putBytes(url, data, headers, label, externalRef) {
      // Presigned URLs carry their signature in the query string: log the label only.
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const started = Date.now();
        try {
          const res = await doFetch(url, { method: 'PUT', headers, body: data, signal: AbortSignal.timeout(600_000) });
          log({ method: 'PUT', path: `storage ${label}`, status: res.status, code: null, ms: Date.now() - started, externalRef, note: `${data.byteLength} bytes` });
          await res.arrayBuffer().catch(() => undefined);
          if (res.status < 300) return res.headers.get('etag');
          if (res.status < 500) throw new Error(`storage refused ${label}: HTTP ${res.status}`);
        } catch (err) {
          if ((err as Error).message.startsWith('storage refused')) throw err;
          log({ method: 'PUT', path: `storage ${label}`, status: 0, code: null, ms: Date.now() - started, externalRef, note: `network: ${(err as Error).name}` });
        }
        await sleep(Math.min(2 ** attempt, 30) * 1000);
      }
      throw new ClaruUnreachable(`upload of ${label} kept failing after ${maxAttempts} tries`);
    },
  };
}
