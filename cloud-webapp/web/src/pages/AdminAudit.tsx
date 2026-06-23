import { useCallback, useEffect, useState } from 'react';
import type { AuditRecord, ListAuditResponse } from '@cloud-webapp/shared';
import { apiGet, ApiError } from '../lib/api.js';
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    loadError: 'Could not load the audit log.',
    title: 'Audit log',
    restrictedTitle: 'Audit log',
    restricted: 'The audit log is restricted to super admins.',
    exportCsv: 'Export CSV',
    fromDate: 'From date',
    toDate: 'To date',
    actorEmail: 'Actor email',
    actionContains: 'Action contains…',
    resourceType: 'Resource type',
    allTypes: 'All types',
    loading: 'Loading…',
    search: 'Search',
    loadingLog: 'Loading audit log…',
    noEntries: 'No audit entries for this filter.',
    colWhen: 'When',
    colActor: 'Actor',
    colAction: 'Action',
    colType: 'Type',
    colResource: 'Resource',
    colDetails: 'Details',
  },
  zh: {
    loadError: '无法加载审计日志。',
    title: '审计日志',
    restrictedTitle: '审计日志',
    restricted: '审计日志仅限超级管理员访问。',
    exportCsv: '导出 CSV',
    fromDate: '起始日期',
    toDate: '结束日期',
    actorEmail: '操作者邮箱',
    actionContains: '操作包含…',
    resourceType: '资源类型',
    allTypes: '全部类型',
    loading: '加载中…',
    search: '搜索',
    loadingLog: '正在加载审计日志…',
    noEntries: '此筛选条件下暂无审计记录。',
    colWhen: '时间',
    colActor: '操作者',
    colAction: '操作',
    colType: '类型',
    colResource: '资源',
    colDetails: '详情',
  },
};

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
  const t = useStrings(STR);
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
      else setError(e instanceof Error ? e.message : t.loadError);
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
        <h2>{t.restrictedTitle}</h2>
        <p className="muted">{t.restricted}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="gallery-header">
        <h2>{t.title}</h2>
        <button className="btn btn-light btn-sm" onClick={downloadCsv} disabled={!records || records.length === 0}>
          {t.exportCsv}
        </button>
      </div>

      <div className="feedback-filters">
        <input className="feedback-input" type="date" value={since} onChange={(e) => setSince(e.target.value)} aria-label={t.fromDate} />
        <input className="feedback-input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label={t.toDate} />
        <input className="feedback-input" placeholder={t.actorEmail} value={actor} onChange={(e) => setActor(e.target.value)} />
        <input className="feedback-input" placeholder={t.actionContains} value={action} onChange={(e) => setAction(e.target.value)} />
        <select className="feedback-input" value={type} onChange={(e) => setType(e.target.value)} aria-label={t.resourceType}>
          {TYPES.map((ty) => (
            <option key={ty} value={ty}>
              {ty === '' ? t.allTypes : ty}
            </option>
          ))}
        </select>
        <button className="btn btn-light btn-sm" onClick={() => void load()} disabled={loading}>
          {loading ? t.loading : t.search}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {records === null ? (
        <p className="muted">{t.loadingLog}</p>
      ) : records.length === 0 ? (
        <p className="muted">{t.noEntries}</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t.colWhen}</th>
                <th>{t.colActor}</th>
                <th>{t.colAction}</th>
                <th>{t.colType}</th>
                <th>{t.colResource}</th>
                <th>{t.colDetails}</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.auditId}>
                  <td className="muted" data-label={t.colWhen}>{fmtWhen(r.timestamp)}</td>
                  <td data-label={t.colActor}>{r.actorEmail || '—'}</td>
                  <td className="mono" data-label={t.colAction}>{r.action}</td>
                  <td data-label={t.colType}>{r.resourceType}</td>
                  <td className="mono" data-label={t.colResource}>{r.resourceId || '—'}</td>
                  <td className="muted" data-label={t.colDetails}>{r.details || r.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
