/**
 * emailPrefs.ts — an admin's own email opt-in settings (dev plan G4.1). Reads/
 * writes the caller's row in the Email_Preferences tab (Sheet SSOT). Any admin
 * manages only their OWN prefs (keyed by their verified email), so there is no
 * club scope here.
 */

import { Router } from 'express';
import { UpdateEmailPrefsRequestSchema, type EmailPrefsResponse } from '@cloud-webapp/shared';

import { requireAuth } from '../middleware/auth.js';
import { attachRole, requireAnyAdmin } from '../middleware/rbac.js';
import { getPrefs, setPrefs } from '../services/emailPrefsStore.js';
import { handleStoreError, masterSheetId } from './adminShared.js';

export const emailPrefsRouter = Router();

emailPrefsRouter.get('/admin/email-prefs', requireAuth, attachRole, requireAnyAdmin, async (req, res, next) => {
  try {
    const sid = masterSheetId(res);
    if (!sid) return;
    const prefs = await getPrefs(sid, req.user!.email ?? '');
    const body: EmailPrefsResponse = { ok: true, prefs };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

emailPrefsRouter.patch('/admin/email-prefs', requireAuth, attachRole, requireAnyAdmin, async (req, res, next) => {
  try {
    const sid = masterSheetId(res);
    if (!sid) return;
    const patch = UpdateEmailPrefsRequestSchema.parse(req.body ?? {});
    const prefs = await setPrefs(sid, req.user!.email ?? '', patch);
    const body: EmailPrefsResponse = { ok: true, prefs };
    res.json(body);
  } catch (err) {
    if (handleStoreError(err, res)) return;
    next(err);
  }
});
