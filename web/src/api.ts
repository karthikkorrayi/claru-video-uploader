import type { ApiErrorCode } from '@cvu/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'network_error' | 'unknown',
    message?: string,
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
  const data = (await res.json().catch(() => ({}))) as { error?: ApiErrorCode; message?: string } & T;
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'unknown', data.message);
  return data;
}

const MESSAGES: Partial<Record<ApiError['code'], string>> = {
  invalid_credentials: 'Wrong username or password.',
  too_many_attempts: 'Too many failed attempts. Wait 15 minutes and try again.',
  username_taken: 'That username is already in use.',
  admin_only: 'Only the admin can do that.',
  network_error: 'Cannot reach the server.',
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message !== err.code ? err.message : (MESSAGES[err.code] ?? `Error: ${err.code}`);
  return String(err);
}
