import { useEffect, useState } from 'react';
import type { HealthResponse } from '@cloud-webapp/shared';
import { apiGet } from './lib/api.js';

export function App(): JSX.Element {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<HealthResponse>('/api/health')
      .then(setHealth)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main className="page">
      <h1>Event Photo Database</h1>
      <p>Cloud webapp scaffold — replaces the gas-app implementation.</p>

      <section>
        <h2>API status</h2>
        {error ? (
          <pre className="error">Could not reach api: {error}</pre>
        ) : health ? (
          <pre>{JSON.stringify(health, null, 2)}</pre>
        ) : (
          <p>Loading…</p>
        )}
      </section>
    </main>
  );
}
