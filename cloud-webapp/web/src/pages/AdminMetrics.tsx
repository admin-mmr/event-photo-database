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
      else setError(e instanceof Error ? e.message : 'Could not load metrics. · 无法加载指标。');
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
        <h2>Metrics · 指标</h2>
        <p className="muted">Metrics are admin-only — sign in with an admin account. · 指标仅限管理员，请使用管理员账号登录。</p>
      </div>
    );
  }

  const cardRow = { display: 'flex', flexWrap: 'wrap' as const, gap: 10, marginBottom: 18 };

  return (
    <div>
      <div className="gallery-header">
        <h2>Metrics · 指标</h2>
        <select className="feedback-input" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Window · 时间范围">
          {WINDOWS.map((w) => (
            <option key={w.days} value={w.days}>
              Last {w.label} · 最近 {w.days} 天
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error-text">{error}</p>}

      {data === null ? (
        <p className="muted">{loading ? 'Loading metrics… · 正在加载指标…' : '—'}</p>
      ) : (
        <>
          <h3 className="muted" style={{ marginBottom: 8 }}>Find Me · 找到我 · last {data.window.sinceDays} days · 最近 {data.window.sinceDays} 天</h3>
          <div style={cardRow}>
            <Stat label="Searches · 搜索次数" value={data.searches} />
            <Stat label="Distinct searchers · 独立搜索者" value={data.distinctSearchers} />
            <Stat label="Fused / person · 融合 / 人物" value={`${data.searchesByMode.fused} / ${data.searchesByMode.person}`} />
            <Stat label="Consent coverage · 同意覆盖率" value={pct(data.consent.coverage)} />
            <Stat label="Judged precision · 评估精度" value={data.feedback.precision === null ? 'n/a · 无' : pct(data.feedback.precision)} />
            <Stat label="Confirmed / wrong · 确认 / 错误" value={`${data.feedback.confirmed} / ${data.feedback.not_me}`} />
            <Stat label="Minor searches · 未成年人搜索" value={data.minorSearches} />
            <Stat label="Data deletions · 数据删除" value={data.dataDeletions} />
          </div>

          {data.platform && (
            <>
              <h3 className="muted" style={{ marginBottom: 8 }}>Platform · 平台 · current · 当前</h3>
              <div style={cardRow}>
                <Stat label="Events · 活动" value={data.platform.events} />
                <Stat label="Indexed photos · 已索引照片" value={data.platform.photos} />
                <Stat label="Active clubs · 活跃俱乐部" value={data.platform.clubs ?? '—'} />
                <Stat label="Active users · 活跃用户" value={data.platform.activeUsers ?? '—'} />
                <Stat label="Total users · 用户总数" value={data.platform.users ?? '—'} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
