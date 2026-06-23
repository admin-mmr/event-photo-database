import { useCallback, useEffect, useState } from 'react';
import type { AdminMetricsResponse } from '@cloud-webapp/shared';
import { apiGet, ApiError } from '../lib/api.js';
import { useStrings } from '../lib/i18n.js';

const STR = {
  en: {
    loadError: 'Could not load metrics.',
    title: 'Metrics',
    restricted: 'Metrics are admin-only — sign in with an admin account.',
    window: 'Window',
    windowOption: (days: number) => `Last ${days} days`,
    loading: 'Loading metrics…',
    findMeHeading: (n: number) => `Find Me · last ${n} days`,
    searches: 'Searches',
    distinctSearchers: 'Distinct searchers',
    fusedPerson: 'Fused / person',
    consentCoverage: 'Consent coverage',
    judgedPrecision: 'Judged precision',
    precisionNa: 'n/a',
    confirmedWrong: 'Confirmed / wrong',
    minorSearches: 'Minor searches',
    dataDeletions: 'Data deletions',
    platformHeading: 'Platform · current',
    events: 'Events',
    indexedPhotos: 'Indexed photos',
    activeClubs: 'Active clubs',
    activeUsers: 'Active users',
    totalUsers: 'Total users',
  },
  zh: {
    loadError: '无法加载指标。',
    title: '指标',
    restricted: '指标仅限管理员，请使用管理员账号登录。',
    window: '时间范围',
    windowOption: (days: number) => `最近 ${days} 天`,
    loading: '正在加载指标…',
    findMeHeading: (n: number) => `人脸识别 · 最近 ${n} 天`,
    searches: '搜索次数',
    distinctSearchers: '独立搜索者',
    fusedPerson: '融合 / 人物',
    consentCoverage: '同意覆盖率',
    judgedPrecision: '评估精度',
    precisionNa: '无',
    confirmedWrong: '确认 / 错误',
    minorSearches: '未成年人搜索',
    dataDeletions: '数据删除',
    platformHeading: '平台 · 当前',
    events: '活动',
    indexedPhotos: '已索引照片',
    activeClubs: '活跃俱乐部',
    activeUsers: '活跃用户',
    totalUsers: '用户总数',
  },
};

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
  const t = useStrings(STR);
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
      else setError(e instanceof Error ? e.message : t.loadError);
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
        <h2>{t.title}</h2>
        <p className="muted">{t.restricted}</p>
      </div>
    );
  }

  const cardRow = { display: 'flex', flexWrap: 'wrap' as const, gap: 10, marginBottom: 18 };

  return (
    <div>
      <div className="gallery-header">
        <h2>{t.title}</h2>
        <select className="feedback-input" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label={t.window}>
          {WINDOWS.map((w) => (
            <option key={w.days} value={w.days}>
              {t.windowOption(w.days)}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error-text">{error}</p>}

      {data === null ? (
        <p className="muted">{loading ? t.loading : '—'}</p>
      ) : (
        <>
          <h3 className="muted" style={{ marginBottom: 8 }}>{t.findMeHeading(data.window.sinceDays)}</h3>
          <div style={cardRow}>
            <Stat label={t.searches} value={data.searches} />
            <Stat label={t.distinctSearchers} value={data.distinctSearchers} />
            <Stat label={t.fusedPerson} value={`${data.searchesByMode.fused} / ${data.searchesByMode.person}`} />
            <Stat label={t.consentCoverage} value={pct(data.consent.coverage)} />
            <Stat label={t.judgedPrecision} value={data.feedback.precision === null ? t.precisionNa : pct(data.feedback.precision)} />
            <Stat label={t.confirmedWrong} value={`${data.feedback.confirmed} / ${data.feedback.not_me}`} />
            <Stat label={t.minorSearches} value={data.minorSearches} />
            <Stat label={t.dataDeletions} value={data.dataDeletions} />
          </div>

          {data.platform && (
            <>
              <h3 className="muted" style={{ marginBottom: 8 }}>{t.platformHeading}</h3>
              <div style={cardRow}>
                <Stat label={t.events} value={data.platform.events} />
                <Stat label={t.indexedPhotos} value={data.platform.photos} />
                <Stat label={t.activeClubs} value={data.platform.clubs ?? '—'} />
                <Stat label={t.activeUsers} value={data.platform.activeUsers ?? '—'} />
                <Stat label={t.totalUsers} value={data.platform.users ?? '—'} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
