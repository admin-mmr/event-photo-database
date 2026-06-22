import { useCallback, useEffect, useState } from 'react';
import type { AdminMetricsResponse } from '@cloud-webapp/shared';
import { apiGet, ApiError } from '../lib/api.js';

const WINDOWS = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
];

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function Stat({ label, value }: { label: string; value: string | number }): JSX.Element {
  return (
    <div className="metric-card" style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: '12px 14px', minWidth: 120 }}>
      <div style={{ fontSize: 22, fontWeight: 600 }}>{value}</div>
      <div className="muted" style={{ fontSize: 13 }}>{label}</div>
    </div>
  );
}

/**
 * Admin metrics dashboard (dev plan M6.2 + control-plane counts). Find Me KPIs
 * over a window plus current platform totals, from GET /api/admin/metrics.
 * Super-admin / admin only (server-enforced). Mobile-friendly: stat cards wrap.
 */
export function AdminMetrics(): JSX.Element {
  const [data, setData] = useState<AdminMetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const r = await apiGet<AdminMetricsResponse>(`/api/admin/metrics?sinceDays=${days}`);
      setData(r);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError(e instanceof Error ? e.message : 'Could not load metrics.');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  if (forbidden) {
    return (
      <div>
        <h2>Metrics</h2>
        <p className="muted">Metrics are admin-only — sign in with an admin account.</p>
      </div>
    );
  }

  const cardRow = { display: 'flex', flexWrap: 'wrap' as const, gap: 10, marginBottom: 18 };

  return (
    <div>
      <div className="gallery-header">
        <h2>Metrics</h2>
        <select className="feedback-input" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Window">
          {WINDOWS.map((w) => (
            <option key={w.days} value={w.days}>
              Last {w.label}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error-text">{error}</p>}

      {data === null ? (
        <p className="muted">{loading ? 'Loading metrics…' : '—'}</p>
      ) : (
        <>
          <h3 className="muted" style={{ marginBottom: 8 }}>Find Me · last {data.window.sinceDays} days</h3>
          <div style={cardRow}>
            <Stat label="Searches" value={data.searches} />
            <Stat label="Distinct searchers" value={data.distinctSearchers} />
            <Stat label="Fused / person" value={`${data.searchesByMode.fused} / ${data.searchesByMode.person}`} />
            <Stat label="Consent coverage" value={pct(data.consent.coverage)} />
            <Stat label="Judged precision" value={data.feedback.precision === null ? 'n/a' : pct(data.feedback.precision)} />
            <Stat label="Confirmed / wrong" value={`${data.feedback.confirmed} / ${data.feedback.not_me}`} />
            <Stat label="Minor searches" value={data.minorSearches} />
            <Stat label="Data deletions" value={data.dataDeletions} />
          </div>

          {data.platform && (
            <>
              <h3 className="muted" style={{ marginBottom: 8 }}>Platform · current</h3>
              <div style={cardRow}>
                <Stat label="Events" value={data.platform.events} />
                <Stat label="Indexed photos" value={data.platform.photos} />
                <Stat label="Active clubs" value={data.platform.clubs ?? '—'} />
                <Stat label="Active users" value={data.platform.activeUsers ?? '—'} />
                <Stat label="Total users" value={data.platform.users ?? '—'} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
