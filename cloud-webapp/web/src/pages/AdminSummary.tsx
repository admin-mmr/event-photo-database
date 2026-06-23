import { useCallback, useEffect, useState } from 'react';
import type { SummaryResponse } from '@cloud-webapp/shared';
import { apiGet, ApiError } from '../lib/api.js';
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    title: 'Upload report',
    exportCsv: 'Export CSV',
    forbidden: 'Reporting is admin-only — sign in with an admin account.',
    loadError: 'Could not load the report.',
    fromDate: 'From date',
    toDate: 'To date',
    loading: 'Loading…',
    apply: 'Apply',
    loadingReport: 'Loading report…',
    sessionsBadge: (n: number) => `${n} sessions`,
    filesBadge: (n: number) => `${n} files`,
    noUploads: 'No uploads in this range.',
    club: 'Club',
    sessions: 'Sessions',
    files: 'Files',
    sizeMb: 'Size (MB)',
  },
  zh: {
    title: '上传报告',
    exportCsv: '导出 CSV',
    forbidden: '报告功能仅限管理员，请使用管理员账号登录。',
    loadError: '无法加载报告。',
    fromDate: '起始日期',
    toDate: '结束日期',
    loading: '加载中…',
    apply: '应用',
    loadingReport: '正在加载报告…',
    sessionsBadge: (n: number) => `${n} 次会话`,
    filesBadge: (n: number) => `${n} 个文件`,
    noUploads: '此时间范围内暂无上传。',
    club: '俱乐部',
    sessions: '会话',
    files: '文件',
    sizeMb: '大小（MB）',
  },
};

function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Upload reporting (dev plan G5.2). Totals + per-club breakdown for a date range,
 * with client-side CSV export. Club-scoped server-side (a club_admin only sees
 * their own numbers). Mobile-friendly via the responsive filter/table classes.
 */
export function AdminSummary(): JSX.Element {
  const t = useStrings(STR);
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
      else setError(e instanceof Error ? e.message : t.loadError);
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
        <h2>{t.title}</h2>
        <p className="muted">{t.forbidden}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>{t.title}</h2>
        <button className="btn btn-light btn-sm" onClick={downloadCsv} disabled={!data}>
          {t.exportCsv}
        </button>
      </div>

      <div className="feedback-filters">
        <input className="feedback-input" type="date" value={since} onChange={(e) => setSince(e.target.value)} aria-label={t.fromDate} />
        <input className="feedback-input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label={t.toDate} />
        <button className="btn btn-light btn-sm" onClick={() => void load()} disabled={loading}>
          {loading ? t.loading : t.apply}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {data === null ? (
        <p className="muted">{t.loadingReport}</p>
      ) : (
        <>
          <div className="event-meta" style={{ marginBottom: 12 }}>
            <span className="badge badge-ok">{t.sessionsBadge(data.totals.sessions)}</span>
            <span className="badge badge-ok">{t.filesBadge(data.totals.files)}</span>
            <span className="muted event-stat">{data.totals.sizeMb} MB</span>
          </div>
          {data.byClub.length === 0 ? (
            <p className="muted">{t.noUploads}</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{t.club}</th>
                    <th>{t.sessions}</th>
                    <th>{t.files}</th>
                    <th>{t.sizeMb}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byClub.map((c) => (
                    <tr key={c.clubName}>
                      <td className="mono" data-label={t.club}>{c.clubName || '—'}</td>
                      <td data-label={t.sessions}>{c.sessions}</td>
                      <td data-label={t.files}>{c.files}</td>
                      <td data-label={t.sizeMb}>{c.sizeMb}</td>
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
