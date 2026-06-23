import { useCallback, useEffect, useState } from 'react';
import type { EmailPrefs as Prefs, EmailPrefsResponse, UpdateEmailPrefsRequest } from '@cloud-webapp/shared';
import { apiGet, apiPatch, ApiError } from '../lib/api.js';
import { useStrings } from '../lib/i18n.js';

type FlagKey = keyof UpdateEmailPrefsRequest;

const STR = {
  en: {
    flagUserCreated: 'A user is added',
    flagUserRoleChanged: "A user's role changes",
    flagUserDeactivated: 'A user is deactivated',
    flagSecurityEvent: 'Security events (failed sign-ins)',
    flagEventCreated: 'A new event is created',
    flagDailyReport: 'Daily activity digest',
    flagWeeklyReport: 'Weekly activity digest',
    groupNotifications: 'Notifications',
    groupDigests: 'Digests',
    couldNotLoad: 'Could not load your email settings.',
    couldNotSave: 'Could not save.',
    heading: 'Email settings',
    adminOnly: 'Email settings are for admin accounts.',
    loading: 'Loading…',
    saving: 'Saving…',
    saveSettings: 'Save settings',
    saved: 'Saved',
  },
  zh: {
    flagUserCreated: '新增用户时',
    flagUserRoleChanged: '用户角色变更时',
    flagUserDeactivated: '用户被停用时',
    flagSecurityEvent: '安全事件（登录失败）',
    flagEventCreated: '创建新活动时',
    flagDailyReport: '每日活动摘要',
    flagWeeklyReport: '每周活动摘要',
    groupNotifications: '通知',
    groupDigests: '摘要',
    couldNotLoad: '无法加载您的邮件设置。',
    couldNotSave: '无法保存。',
    heading: '邮件设置',
    adminOnly: '邮件设置仅适用于管理员账号。',
    loading: '加载中…',
    saving: '保存中…',
    saveSettings: '保存设置',
    saved: '已保存',
  },
};

const FLAGS: Array<{ key: FlagKey; labelKey: keyof typeof STR.en; group: 'Notifications' | 'Digests' }> = [
  { key: 'userCreated', labelKey: 'flagUserCreated', group: 'Notifications' },
  { key: 'userRoleChanged', labelKey: 'flagUserRoleChanged', group: 'Notifications' },
  { key: 'userDeactivated', labelKey: 'flagUserDeactivated', group: 'Notifications' },
  { key: 'securityEvent', labelKey: 'flagSecurityEvent', group: 'Notifications' },
  { key: 'eventCreated', labelKey: 'flagEventCreated', group: 'Notifications' },
  { key: 'dailyReport', labelKey: 'flagDailyReport', group: 'Digests' },
  { key: 'weeklyReport', labelKey: 'flagWeeklyReport', group: 'Digests' },
];

/**
 * An admin's own email opt-in settings (dev plan G4.1). GET/PATCH
 * /api/admin/email-prefs (keyed by the caller's email). Mobile-friendly: the
 * toggle rows stack naturally and the save bar wraps.
 */
export function EmailPrefs(): JSX.Element {
  const t = useStrings(STR);
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
      else setError(e instanceof Error ? e.message : t.couldNotLoad);
    }
  }, [t]);

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
      setError(e instanceof Error ? e.message : t.couldNotSave);
    } finally {
      setSaving(false);
    }
  }

  if (forbidden) {
    return (
      <div>
        <h2>{t.heading}</h2>
        <p className="muted">{t.adminOnly}</p>
      </div>
    );
  }

  return (
    <div>
      <h2>{t.heading}</h2>
      {error && <p className="error-text">{error}</p>}
      {prefs === null ? (
        <p className="muted">{t.loading}</p>
      ) : (
        <>
          {(['Notifications', 'Digests'] as const).map((group) => (
            <fieldset key={group} style={{ border: 'none', padding: 0, margin: '0 0 16px' }}>
              <legend className="muted" style={{ marginBottom: 6 }}>
                {group === 'Notifications' ? t.groupNotifications : t.groupDigests}
              </legend>
              {FLAGS.filter((f) => f.group === group).map((f) => (
                <label key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                  <input type="checkbox" checked={prefs[f.key]} onChange={() => toggle(f.key)} />
                  <span>{t[f.labelKey]}</span>
                </label>
              ))}
            </fieldset>
          ))}
          <div className="feedback-filters">
            <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving}>
              {saving ? t.saving : t.saveSettings}
            </button>
            {saved && <span className="badge badge-ok">{t.saved}</span>}
          </div>
        </>
      )}
    </div>
  );
}
