import { useCallback, useEffect, useState } from 'react';
import type { EmailPrefs as Prefs, EmailPrefsResponse, UpdateEmailPrefsRequest } from '@cloud-webapp/shared';
import { apiGet, apiPatch, ApiError } from '../lib/api.js';

type FlagKey = keyof UpdateEmailPrefsRequest;

const FLAGS: Array<{ key: FlagKey; label: string; group: 'Notifications' | 'Digests' }> = [
  { key: 'userCreated', label: 'A user is added · 新增用户时', group: 'Notifications' },
  { key: 'userRoleChanged', label: "A user's role changes · 用户角色变更时", group: 'Notifications' },
  { key: 'userDeactivated', label: 'A user is deactivated · 用户被停用时', group: 'Notifications' },
  { key: 'securityEvent', label: 'Security events (failed sign-ins) · 安全事件（登录失败）', group: 'Notifications' },
  { key: 'eventCreated', label: 'A new event is created · 创建新活动时', group: 'Notifications' },
  { key: 'dailyReport', label: 'Daily activity digest · 每日活动摘要', group: 'Digests' },
  { key: 'weeklyReport', label: 'Weekly activity digest · 每周活动摘要', group: 'Digests' },
];

/** Bilingual display label for the two flag groups (the group value itself stays
 *  English so it can key the FLAGS filter / the iteration below). */
const GROUP_LABEL: Record<'Notifications' | 'Digests', string> = {
  Notifications: 'Notifications · 通知',
  Digests: 'Digests · 摘要',
};

/**
 * An admin's own email opt-in settings (dev plan G4.1). GET/PATCH
 * /api/admin/email-prefs (keyed by the caller's email). Mobile-friendly: the
 * toggle rows stack naturally and the save bar wraps.
 */
export function EmailPrefs(): JSX.Element {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setForbidden(false);
    try {
      const r = await apiGet<EmailPrefsResponse>('/api/admin/email-prefs');
      setPrefs(r.prefs);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError(e instanceof Error ? e.message : 'Could not load your email settings. · 无法加载您的邮件设置。');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(key: FlagKey): void {
    setSaved(false);
    setPrefs((p) => (p ? { ...p, [key]: !p[key] } : p));
  }

  async function save(): Promise<void> {
    if (!prefs) return;
    setSaving(true);
    setError(null);
    try {
      const patch: UpdateEmailPrefsRequest = {
        userCreated: prefs.userCreated,
        userRoleChanged: prefs.userRoleChanged,
        userDeactivated: prefs.userDeactivated,
        securityEvent: prefs.securityEvent,
        eventCreated: prefs.eventCreated,
        dailyReport: prefs.dailyReport,
        weeklyReport: prefs.weeklyReport,
      };
      const r = await apiPatch<EmailPrefsResponse>('/api/admin/email-prefs', patch);
      setPrefs(r.prefs);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. · 无法保存。');
    } finally {
      setSaving(false);
    }
  }

  if (forbidden) {
    return (
      <div>
        <h2>Email settings · 邮件设置</h2>
        <p className="muted">Email settings are for admin accounts. · 邮件设置仅适用于管理员账号。</p>
      </div>
    );
  }

  return (
    <div>
      <h2>Email settings · 邮件设置</h2>
      {error && <p className="error-text">{error}</p>}
      {prefs === null ? (
        <p className="muted">Loading… · 加载中…</p>
      ) : (
        <>
          {(['Notifications', 'Digests'] as const).map((group) => (
            <fieldset key={group} style={{ border: 'none', padding: 0, margin: '0 0 16px' }}>
              <legend className="muted" style={{ marginBottom: 6 }}>
                {GROUP_LABEL[group]}
              </legend>
              {FLAGS.filter((f) => f.group === group).map((f) => (
                <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                  <input type="checkbox" checked={prefs[f.key]} onChange={() => toggle(f.key)} />
                  <span>{f.label}</span>
                </label>
              ))}
            </fieldset>
          ))}
          <div className="feedback-filters">
            <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving… · 保存中…' : 'Save settings · 保存设置'}
            </button>
            {saved && <span className="badge badge-ok">Saved · 已保存</span>}
          </div>
        </>
      )}
    </div>
  );
}
