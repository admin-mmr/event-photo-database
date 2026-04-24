/**
 * emailTemplates.ts — Branding constants and HTML rendering helpers.
 *
 * Extracted from emailService.ts (§1.1 god-file split) so that all
 * presentation/template concerns live in isolation from dispatch, quota
 * management, and trigger installation.
 *
 * Every export is a pure function or constant — no MailApp, no sheet I/O.
 */

import { getCanonicalScriptUrl } from '../utils/scriptUrl';

// ─── Branding ─────────────────────────────────────────────────────────────────

/**
 * Product name shown in subjects and the email header banner.
 * Mirrors the on-screen title used by pageRoutes.renderTemplate().
 */
export const PRODUCT_NAME    = '湘舍动公益文件系统';
export const PRODUCT_NAME_EN = 'Event Photo Database';

/**
 * Returns the canonical deployment URL with an optional action path appended.
 * Used in every email CTA button so recipients land on the correct page
 * regardless of which Workspace / Gmail URL shape ScriptApp returned.
 */
export function mainPageUrl(action = 'dashboard'): string {
  return `${getCanonicalScriptUrl()}?action=${encodeURIComponent(action)}`;
}

// ─── HTML rendering ──────────────────────────────────────────────────────────

/**
 * Minimal HTML-escape for inlining user-supplied values inside email bodies.
 * Email clients render HTML liberally — never concatenate raw values without
 * passing them through this helper first.
 */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wraps inner HTML in a branded layout with header / footer / CTA button slot.
 *
 * Inline CSS only — Gmail strips <style> blocks and most external stylesheets.
 * Keep colour / spacing choices consistent with the in-app MDL indigo theme.
 */
export function wrapHtml(
  title: string,
  innerHtml: string,
  ctaLabel?: string,
  ctaUrl?: string
): string {
  const cta = (ctaLabel && ctaUrl)
    ? `<p style="margin:24px 0 8px;">
         <a href="${esc(ctaUrl)}"
            style="background:#3f51b5;color:#fff;text-decoration:none;
                   padding:12px 28px;border-radius:4px;display:inline-block;
                   font-size:15px;font-weight:500;">
           ${esc(ctaLabel)}
         </a>
       </p>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#333;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">
    <div style="background:#3f51b5;color:#fff;padding:16px 24px;border-radius:4px 4px 0 0;">
      <div style="font-size:13px;opacity:0.85;">${esc(PRODUCT_NAME_EN)}</div>
      <div style="font-size:18px;font-weight:500;">${esc(PRODUCT_NAME)}</div>
    </div>
    <div style="background:#fff;padding:24px;border-radius:0 0 4px 4px;
                box-shadow:0 2px 8px rgba(0,0,0,0.08);line-height:1.5;">
      <h2 style="margin:0 0 16px;color:#333;font-size:18px;">${esc(title)}</h2>
      ${innerHtml}
      ${cta}
    </div>
    <div style="color:#888;font-size:12px;text-align:center;padding:16px 8px;">
      This is an automated message from ${esc(PRODUCT_NAME_EN)}.<br>
      You can change what you receive at
      <a href="${esc(mainPageUrl('admin_email_prefs'))}" style="color:#3f51b5;">
        Email Preferences
      </a>.
    </div>
  </div>
</body></html>`;
}

/**
 * Strips tags to produce a plain-text fallback body. Email clients that don't
 * render HTML will fall back to this. Not a full HTML-to-text converter —
 * enough to make the message readable when HTML rendering is disabled.
 */
export function toPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|h\d)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '  • ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();
}
