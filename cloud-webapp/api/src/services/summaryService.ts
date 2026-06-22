/**
 * summaryService.ts — upload reporting over the Upload_Log tab (Sheet SSOT, dev
 * plan G5.2). Mirrors gas-app COLUMNS.UPLOAD_LOG; aggregates session/file/size
 * totals for a date range, broken down by club. Read-only.
 */

import { cell, readTab } from './sheetTable.js';

const TAB = 'Upload_Log';
const LAST_COL = 'N';
const COL = {
  LOG_ID: 0,
  EVENT_ID: 1,
  CLUB_NAME: 2,
  FILE_COUNT: 6,
  TOTAL_SIZE_MB: 7,
  UPLOAD_TIMESTAMP: 10,
} as const;

export interface ClubSummary {
  clubName: string;
  sessions: number;
  files: number;
  sizeMb: number;
}

export interface Summary {
  totals: { sessions: number; files: number; sizeMb: number };
  byClub: ClubSummary[];
}

const num = (s: string): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Aggregate Upload_Log rows in [since, until] (ISO, inclusive; omit for open
 * bounds), optionally filtered to one club. Returns grand totals + per-club rows
 * sorted by file count desc.
 */
export async function summarize(
  spreadsheetId: string,
  filter?: { since?: string; until?: string; clubName?: string },
): Promise<Summary> {
  const rows = await readTab(spreadsheetId, TAB, LAST_COL, COL.LOG_ID, 'logid');

  const perClub = new Map<string, ClubSummary>();
  const totals = { sessions: 0, files: 0, sizeMb: 0 };

  for (const r of rows) {
    const ts = cell(r.cells, COL.UPLOAD_TIMESTAMP);
    if (filter?.since && ts < filter.since) continue;
    if (filter?.until && ts > filter.until) continue;
    const clubName = cell(r.cells, COL.CLUB_NAME);
    if (filter?.clubName !== undefined && clubName !== filter.clubName) continue;

    const files = num(cell(r.cells, COL.FILE_COUNT));
    const sizeMb = num(cell(r.cells, COL.TOTAL_SIZE_MB));

    totals.sessions += 1;
    totals.files += files;
    totals.sizeMb += sizeMb;

    const existing = perClub.get(clubName) ?? { clubName, sessions: 0, files: 0, sizeMb: 0 };
    existing.sessions += 1;
    existing.files += files;
    existing.sizeMb = round2(existing.sizeMb + sizeMb);
    perClub.set(clubName, existing);
  }

  totals.sizeMb = round2(totals.sizeMb);
  const byClub = [...perClub.values()].sort((a, b) => b.files - a.files);
  return { totals, byClub };
}
