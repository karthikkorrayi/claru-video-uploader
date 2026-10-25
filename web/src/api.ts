import type { ApiErrorCode } from '@cvu/shared';
import { reportProblem } from './reporter.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'network_error' | 'unknown' | 'internal_error',
    message?: string,
    /** The server's request id for a server error: quote it when reporting a problem. */
    readonly requestId?: string,
  ) {
    super(message ?? code);
  }
}

/** JSON call to our own server. Always sends the CSRF header; the cookie travels automatically. */
export async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Requested-With': 'cvu',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network_error', 'Cannot reach the server.');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: ApiErrorCode; message?: string; requestId?: string } & T;
  if (!res.ok) {
    const requestId = data.requestId ?? res.headers.get('x-request-id') ?? undefined;
    if (res.status >= 500 && res.status !== 503) {
      reportProblem({ kind: 'api', message: `${method} /api${path} → ${res.status} ${data.error ?? ''}`.trim(), requestId });
    }
    throw new ApiError(res.status, data.error ?? 'unknown', data.message, requestId);
  }
  return data;
}

const MESSAGES: Partial<Record<ApiError['code'], string>> = {
  invalid_credentials: 'Wrong username or password.',
  too_many_attempts: 'Too many failed attempts. Wait 15 minutes and try again.',
  username_taken: 'That username is already in use.',
  admin_only: 'Only the admin can do that.',
  network_error: 'Cannot reach the server.',
  internal_error: 'Something went wrong on the server.',
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const text = err.message !== err.code ? err.message : (MESSAGES[err.code] ?? `Error: ${err.code}`);
    return err.requestId && err.status >= 500 ? `${text} (reference ${err.requestId})` : text;
  }
  return String(err);
}
