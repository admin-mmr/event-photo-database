import { useCallback, useEffect, useState } from 'react';
import type { AuditRecord, ListAuditResponse } from '@cloud-webapp/shared';
import { apiGet, ApiError } from '../lib/api.js';

const TYPES = ['', 'user', 'club', 'event', 'link', 'report', 'other'] as const;

function fmtWhen(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : iso || '—';
}

/** RFC-4180-ish CSV cell: quote when it contains comma/quote/newline. */
function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function toCsv(rows: AuditRecord[]): string {
  const head = ['timestamp', 'actorEmail', 'action', 'resourceType', 'resourceId', 'details', 'linkId', 'ip', 'reason'];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push(
      [r.timestamp, r.actorEmail, r.action, r.resourceType, r.resourceId, r.details, r.linkId, r.ip, r.reason]
        .map((c) => csvCell(String(c ?? '')))
        .join(','),
    );
  }
  return lines.join('\n');
}

/**
 * Audit-log search (dev plan G4.2). Super-admin only (server-enforced). Filters
 * map to query params; CSV export is built client-side from the loaded rows.
 * Mobile-friendly via the responsive filter/table classes.
 */
export function AdminAudit(): JSX.Element {
  const [records, setRecords] = useState<AuditRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);

  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [type, setType] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    const qs = new URLSearchParams();
    if (since) qs.set('since', since);
    if (until) qs.set('until', until);
    if (actor.trim()) qs.set('actor', actor.trim());
    if (action.trim()) qs.set('action', action.trim());
    if (type) qs.set('type', type);
    try {
      const r = await apiGet<ListAuditResponse>(`/api/admin/audit?${qs.toString()}`);
      setRecords(r.records);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError(e instanceof Error ? e.message : 'Could not load the audit log. · 无法加载审计日志。');
    } finally {
      setLoading(false);
    }
  }, [since, until, actor, action, type]);

  useEffect(() => {
    void load();
  }, [load]);

  function downloadCsv(): void {
    if (!records || records.length === 0) return;
    const blob = new Blob([toCsv(records)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
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
        <h2>Audit log · 审计日志</h2>
        <p className="muted">The audit log is restricted to super admins. · 审计日志仅限超级管理员访问。</p>
      </div>
    );
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>Audit log · 审计日志</h2>
        <button className="btn btn-light btn-sm" onClick={downloadCsv} disabled={!records || records.length === 0}>
          Export CSV · 导出 CSV
        </button>
      </div>

      <div className="feedback-filters">
        <input className="feedback-input" type="date" value={since} onChange={(e) => setSince(e.target.value)} aria-label="From date · 起始日期" />
        <input className="feedback-input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="To date · 结束日期" />
        <input className="feedback-input" placeholder="Actor email · 操作者邮箱" value={actor} onChange={(e) => setActor(e.target.value)} />
        <input className="feedback-input" placeholder="Action contains… · 操作包含…" value={action} onChange={(e) => setAction(e.target.value)} />
        <select className="feedback-input" value={type} onChange={(e) => setType(e.target.value)} aria-label="Resource type · 资源类型">
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t === '' ? 'All types · 全部类型' : t}
            </option>
          ))}
        </select>
        <button className="btn btn-light btn-sm" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading… · 加载中…' : 'Search · 搜索'}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {records === null ? (
        <p className="muted">Loading audit log… · 正在加载审计日志…</p>
      ) : records.length === 0 ? (
        <p className="muted">No audit entries for this filter. · 此筛选条件下暂无审计记录。</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>When · 时间</th>
                <th>Actor · 操作者</th>
                <th>Action · 操作</th>
                <th>Type · 类型</th>
                <th>Resource · 资源</th>
                <th>Details · 详情</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.auditId}>
                  <td className="muted">{fmtWhen(r.timestamp)}</td>
                  <td>{r.actorEmail || '—'}</td>
                  <td className="mono">{r.action}</td>
                  <td>{r.resourceType}</td>
                  <td className="mono">{r.resourceId || '—'}</td>
                  <td className="muted">{r.details || r.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
