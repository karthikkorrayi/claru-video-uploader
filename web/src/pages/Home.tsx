import { useEffect, useState } from 'react';
import type { HealthReport, PublicUser } from '@cvu/shared';

export function HomePage({ user }: { user: PublicUser }) {
  const [health, setHealth] = useState<HealthReport | null>(null);

  useEffect(() => {
    fetch('/api/healthz')
      .then((r) => r.json() as Promise<HealthReport>)
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  return (
    <section className="card">
      <h1>Welcome, {user.displayName}</h1>
      <p>
        Signed in as <strong>{user.username}</strong> ({user.role}).
      </p>
      <p className="muted">Uploading arrives in phase L2.</p>
      {health && (
        <p className={health.ok ? 'ok' : 'error'}>
          {health.ok ? '✓' : '✗'} Server and database {health.ok ? `up (PostgreSQL ${health.db.version})` : 'not healthy'}
        </p>
      )}
    </section>
  );
}
