/**
 * Sends errors from this browser to the server's Problems list, so the admin
 * can see what went wrong on a tester's computer. Best effort: it never throws,
 * repeats of the same message within a minute are dropped, and nothing is sent
 * before sign-in (the server would refuse it anyway).
 */
const lastSent = new Map<string, number>();

export interface ProblemReport {
  kind: 'error' | 'unhandledrejection' | 'upload' | 'api';
  message: string;
  stack?: string;
  requestId?: string;
}

export function reportProblem(p: ProblemReport): void {
  const key = `${p.kind}:${p.message}`;
  const now = Date.now();
  if (now - (lastSent.get(key) ?? 0) < 60_000) return;
  lastSent.set(key, now);
  const body = JSON.stringify({
    kind: p.kind,
    message: p.message.slice(0, 1000),
    stack: p.stack?.slice(0, 4000),
    page: `${location.pathname}${location.hash}`.slice(0, 300),
    requestId: p.requestId,
  });
  fetch('/api/client-errors', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'cvu' },
    body,
    keepalive: true,
  }).catch(() => undefined);
}

export function installErrorReporter(): void {
  window.addEventListener('error', (e) => {
    reportProblem({ kind: 'error', message: e.message || 'Script error', stack: (e.error as Error | undefined)?.stack });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as Error | string | undefined;
    reportProblem({ kind: 'unhandledrejection', message: typeof r === 'string' ? r : (r?.message ?? 'Unhandled promise rejection'), stack: typeof r === 'object' ? r?.stack : undefined });
  });
}
