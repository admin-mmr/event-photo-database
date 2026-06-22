/**
 * emailTemplates.ts — pure builders for the transactional + digest emails (dev
 * plan G4.1). Each returns { subject, html, text }; no side effects, so they are
 * trivially unit-testable. Mirrors the gas-app emailTemplates set, trimmed to
 * the notifications wired in this milestone.
 */

import { env } from '../lib/config.js';

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

const APP = 'Event Photo Database';

/** Optional "Open the app" link block; omitted when APP_BASE_URL is unset. */
function linkBlock(path = ''): { html: string; text: string } {
  if (!env.APP_BASE_URL) return { html: '', text: '' };
  const url = `${env.APP_BASE_URL.replace(/\/$/, '')}${path}`;
  return { html: `<p><a href="${url}">Open ${APP}</a></p>`, text: `\nOpen ${APP}: ${url}\n` };
}

function wrap(title: string, bodyHtml: string, link = ''): string {
  return `<div style="font-family:system-ui,Arial,sans-serif;font-size:15px;line-height:1.5">
<h2 style="margin:0 0 12px">${title}</h2>${bodyHtml}${linkBlock(link).html}
<p style="color:#888;font-size:12px;margin-top:20px">${APP} · automated message</p></div>`;
}

export function welcomeUser(name: string, role: string): EmailContent {
  const who = name.trim() || 'there';
  return {
    subject: `Welcome to ${APP}`,
    html: wrap(`Welcome, ${who}`, `<p>Your ${APP} account is ready with the role <b>${role}</b>.</p>`),
    text: `Welcome, ${who}. Your ${APP} account is ready with the role ${role}.${linkBlock().text}`,
  };
}

export function userCreated(actorEmail: string, newEmail: string, role: string): EmailContent {
  return {
    subject: `New user added: ${newEmail}`,
    html: wrap('New user added', `<p><b>${actorEmail}</b> added <b>${newEmail}</b> as <b>${role}</b>.</p>`, '/admin/users'),
    text: `${actorEmail} added ${newEmail} as ${role}.${linkBlock('/admin/users').text}`,
  };
}

export function eventCreated(actorEmail: string, eventName: string, date: string): EmailContent {
  return {
    subject: `New event created: ${eventName}`,
    html: wrap('New event created', `<p><b>${actorEmail}</b> created <b>${eventName}</b> (${date}).</p>`, '/admin/events'),
    text: `${actorEmail} created event ${eventName} (${date}).${linkBlock('/admin/events').text}`,
  };
}

export interface DigestLine {
  action: string;
  resourceId: string;
  actorEmail: string;
}

export function dailyDigest(lines: DigestLine[], sinceIso: string): EmailContent {
  const subject = `${APP} daily digest — ${lines.length} change${lines.length === 1 ? '' : 's'}`;
  if (lines.length === 0) {
    return {
      subject,
      html: wrap('Daily digest', `<p>No admin changes since ${sinceIso}.</p>`),
      text: `No admin changes since ${sinceIso}.`,
    };
  }
  const items = lines
    .map((l) => `<li><code>${l.action}</code> ${l.resourceId} — ${l.actorEmail}</li>`)
    .join('');
  const textItems = lines.map((l) => `- ${l.action} ${l.resourceId} (${l.actorEmail})`).join('\n');
  return {
    subject,
    html: wrap('Daily digest', `<p>Admin changes since ${sinceIso}:</p><ul>${items}</ul>`, '/admin/audit'),
    text: `Admin changes since ${sinceIso}:\n${textItems}${linkBlock('/admin/audit').text}`,
  };
}
