/**
 * linksMessage — the bilingual (中文 + English) text an admin pastes into a
 * group chat to hand out an event's volunteer upload links, followed by how to
 * use Find Me.
 *
 * Always bilingual regardless of the UI language: the audience is a mixed chat,
 * not the admin. Pure (no `window`, no fetch) so the wording is testable; the
 * page supplies the origin and the club display names.
 *
 * Only ACTIVE links are listed — a revoked token rejects uploads, so sharing it
 * would only produce "link not valid" reports.
 */
import type { LinkRecord } from '@cloud-webapp/shared';

export interface LinksMessageInput {
  /** Human event label (already run through `eventLabel`). */
  eventName: string;
  eventId: string;
  /** e.g. `https://mmr-data-pipeline.web.app` — no trailing slash needed. */
  origin: string;
  links: LinkRecord[];
  /** normalizedName → displayName; a club missing here shows its raw id. */
  clubDisplayNames?: ReadonlyMap<string, string>;
}

/** Links that can actually be used, ordered club → tag so a club's links sit
 *  together and the club-level link (empty tag) leads its group. */
export function shareableLinks(links: LinkRecord[], clubDisplayNames?: ReadonlyMap<string, string>): LinkRecord[] {
  const label = (l: LinkRecord): string => clubDisplayNames?.get(l.clubName) ?? l.clubName;
  return links
    .filter((l) => l.status === 'active')
    .sort((a, b) => label(a).localeCompare(label(b)) || a.tag.localeCompare(b.tag));
}

export function buildLinksMessage(input: LinksMessageInput): string {
  const origin = input.origin.replace(/\/+$/, '');
  const links = shareableLinks(input.links, input.clubDisplayNames);
  const findMeUrl = `${origin}/events/${encodeURIComponent(input.eventId)}/findme`;

  const out: string[] = [
    `📸 ${input.eventName}`,
    '照片上传链接 · Photo upload links',
    '',
    '请用你所在俱乐部 / 站点的链接上传照片，无需登录。',
    'Upload with the link for your club / station — no sign-in needed.',
  ];

  if (links.length === 0) {
    out.push('', '（暂无可用的上传链接 · No active upload links yet）');
  }
  links.forEach((l, i) => {
    const club = input.clubDisplayNames?.get(l.clubName) ?? l.clubName;
    out.push('', `🌹 ${i + 1}｜俱乐部 Club：${club}`);
    if (l.tag) out.push(`🏷️ 标签 Tag：${l.tag}`);
    out.push(`📤 ${origin}/upload/${l.token}`);
  });

  out.push(
    '',
    '━━━━━━━━━━',
    '🔍 一键找我 · Find Me',
    '所有俱乐部、所有标签的照片都在一起，一次搜索全部找到。',
    'One search covers every photo of this event — all clubs, all tags.',
    `👉 ${findMeUrl}`,
    '',
    '1️⃣ 输入姓名，点「继续」',
    '    Enter your name and tap Continue',
    '2️⃣ 勾选同意人脸比对（18岁以下需家长确认）',
    '    Tick the consent box (a parent confirms for under-18s)',
    '3️⃣ 上传一张清晰、正面、只有你的照片，自拍最好',
    '    Upload a clear, front-facing photo of just you — a selfie is perfect',
    '4️⃣ 点照片放大确认，标记「✓ 是我」或「不是我」',
    '    Tap a photo to check it, then mark ✓ Me or Not me',
    '5️⃣ 勾选照片后「保存到相册」或「下载 ZIP」',
    '    Select photos, then Save to Photos or Download ZIP',
    '',
    '💡 没有清楚的正脸？可改用「按服装搜索」。',
    '    No clear face? Try “Search by outfit” instead.',
    '🔒 参考照片仅用于本次搜索。',
    '    Your reference photo is used only for this search.',
  );

  return out.join('\n');
}
