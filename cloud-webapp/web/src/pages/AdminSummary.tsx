import { useCallback, useEffect, useState } from 'react';
import type { SummaryResponse } from '@cloud-webapp/shared';
import { apiGet, ApiError } from '../lib/api.js';

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Upload reporting (dev plan G5.2). Totals + per-club breakdown for a date range,
 * with client-side CSV export. Club-scoped server-side (a club_admin only sees
 * their own numbers). Mobile-friendly via the responsive filter/table classes.
 */
export function AdminSummary(): JSX.Element {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);

  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    const qs = new URLSearchParams();
    if (since) qs.set('since', since);
    if (until) qs.set('until', until);
    try {
      const r = await apiGet<SummaryResponse>(`/api/admin/summary?${qs.toString()}`);
      setData(r);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError(e instanceof Error ? e.message : 'Could not load the report. · 无法加载报告。');
    } finally {
      setLoading(false);
    }
  }, [since, until]);

  useEffect(() => {
    void load();
  }, [load]);

  function downloadCsv(): void {
    if (!data) return;
    const head = ['club', 'sessions', 'files', 'sizeMb'];
    const lines = [head.join(',')];
    for (const c of data.byClub) {
      lines.push([c.clubName, String(c.sessions), String(c.files), String(c.sizeMb)].map((x) => csvCell(x)).join(','));
    }
    lines.push(['TOTAL', String(data.totals.sessions), String(data.totals.files), String(data.totals.sizeMb)].join(','));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = `upload-summary-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  }

  if (forbidden) {
    return (
      <div>
        <h2>Upload report · 上传报告</h2>
        <p className="muted">Reporting is admin-only — sign in with an admin account. · 报告功能仅限管理员，请使用管理员账号登录。</p>
      </div>
    );
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>Upload report · 上传报告</h2>
        <button className="btn btn-light btn-sm" onClick={downloadCsv} disabled={!data}>
          Export CSV · 导出 CSV
        </button>
      </div>

      <div className="feedback-filters">
        <input className="feedback-input" type="date" value={since} onChange={(e) => setSince(e.target.value)} aria-label="From date · 起始日期" />
        <input className="feedback-input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="To date · 结束日期" />
        <button className="btn btn-light btn-sm" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading… · 加载中…' : 'Apply · 应用'}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {data === null ? (
        <p className="muted">Loading report… · 正在加载报告…</p>
      ) : (
        <>
          <div className="event-meta" style={{ marginBottom: 12 }}>
            <span className="badge badge-ok">{data.totals.sessions} sessions · {data.totals.sessions} 次会话</span>
            <span className="badge badge-ok">{data.totals.files} files · {data.totals.files} 个文件</span>
            <span className="muted event-stat">{data.totals.sizeMb} MB</span>
          </div>
          {data.byClub.length === 0 ? (
            <p className="muted">No uploads in this range. · 此时间范围内暂无上传。</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Club · 俱乐部</th>
                    <th>Sessions · 会话</th>
                    <th>Files · 文件</th>
                    <th>Size (MB) · 大小（MB）</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byClub.map((c) => (
                    <tr key={c.clubName}>
                      <td className="mono">{c.clubName || '—'}</td>
                      <td>{c.sessions}</td>
                      <td>{c.files}</td>
                      <td>{c.sizeMb}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
