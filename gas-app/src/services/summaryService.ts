import { ResultStatus } from '../types/enums';
import { EventRecord, UploadLogRecord } from '../types/models';
import { ServiceResult } from '../types/responses';
import { FolderViolation } from '../types/responses';
import { listAll as listAllEvents } from './eventService';
import { getAllUploadLogs } from './uploadLogService';
import { scanAllViolations } from './driveService';

/**
 * SummaryService — aggregates Upload_Log + Events data into reconciliation reports.
 *
 * Phase 4 entry point. Provides three lenses on system state:
 *   1. Events WITH uploads — how many photos each club contributed, per event
 *   2. Events WITHOUT uploads — events that need attention
 *   3. Drive naming violations — Layer 1/2 folders that break convention
 *
 * All data is read-only; this service never writes to Sheets or Drive.
 *
 * Performance notes:
 *   - loadAllEvents() + getAllUploadLogs() are two Sheets reads (~2 API calls)
 *   - scanAllViolations() is N+1 Drive API calls (1 root + 1 per event folder)
 *   - For a system with <100 events, this completes well within the 6-min GAS limit
 *   - Results are not cached; each call reads fresh data
 */

// ─── Output types ──────────────────────────────────────────────────────────────

/**
 * Upload contribution from a single club within one event.
 */
export interface ClubUploadSummary {
  readonly clubName: string;
  readonly sessionCount: number;   // Number of distinct upload batches
  readonly fileCount: number;
  readonly totalSizeMb: number;    // Rounded to 2 dp
  readonly lastUploadAt: string;   // ISO 8601 timestamp of most recent session
}

/**
 * Rolled-up summary for one event.
 */
export interface EventSummary {
  readonly event: EventRecord;
  readonly clubs: ReadonlyArray<ClubUploadSummary>;
  readonly totalFiles: number;
  readonly totalSizeMb: number;
  readonly hasUploads: boolean;
}

/**
 * Top-level result returned by generateSummary().
 */
export interface SystemSummary {
  readonly generatedAt: string;                          // ISO 8601 timestamp
  readonly dateFrom: string | null;                      // Applied filter (or null)
  readonly dateTo: string | null;
  readonly eventsWithUploads: ReadonlyArray<EventSummary>;
  readonly eventsWithoutUploads: ReadonlyArray<EventRecord>;
  readonly violations: ReadonlyArray<FolderViolation>;
  readonly totalPhotos: number;
  readonly totalSizeMb: number;
  readonly totalClubs: number;                           // Distinct club names
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Generates a full system summary, optionally filtered by event date range.
 *
 * Steps:
 *   1. Load all events (Events sheet)
 *   2. Load all upload log records (Upload_Log sheet)
 *   3. Optionally filter both by dateFrom / dateTo
 *   4. Group log records by eventId → build per-event, per-club summaries
 *   5. Separate events with and without uploads
 *   6. Run Drive folder scan for naming violations (Layer 1 + 2)
 *   7. Compute system-wide totals
 *
 * @param dateFrom  Optional ISO date "YYYY-MM-DD" — include events on/after this date
 * @param dateTo    Optional ISO date "YYYY-MM-DD" — include events on/before this date
 */
export function generateSummary(
  dateFrom?: string,
  dateTo?: string
): ServiceResult<SystemSummary> {
  try {
    // 1. Load events
    const eventsResult = listAllEvents(1, 1000, 'desc');
    let events = eventsResult.items as EventRecord[];

    // 2. Load upload logs
    const logsResult = getAllUploadLogs();
    if (logsResult.status !== ResultStatus.SUCCESS || !logsResult.data) {
      return { status: ResultStatus.ERROR, message: logsResult.message };
    }
    let logs = logsResult.data as UploadLogRecord[];

    // 3. Apply date filter to events
    if (dateFrom) {
      events = events.filter((e) => e.eventDate >= dateFrom);
    }
    if (dateTo) {
      events = events.filter((e) => e.eventDate <= dateTo);
    }

    // Filter logs to only those belonging to the filtered event set
    const filteredEventIds = new Set(events.map((e) => e.eventId));
    if (dateFrom || dateTo) {
      logs = logs.filter((l) => filteredEventIds.has(l.eventId));
    }

    // 4. Group logs by eventId → clubName
    const logsByEvent = groupLogsByEvent(logs);

    // 5. Build per-event summaries
    const eventsWithUploads: EventSummary[] = [];
    const eventsWithoutUploads: EventRecord[] = [];

    for (const event of events) {
      const eventLogs = logsByEvent.get(event.eventId) ?? [];
      if (eventLogs.length === 0) {
        eventsWithoutUploads.push(event);
        continue;
      }

      const clubMap = groupLogsByClub(eventLogs);
      const clubs: ClubUploadSummary[] = [];

      clubMap.forEach((clubLogs, clubName) => {
        const fileCount = clubLogs.reduce((s, l) => s + l.fileCount, 0);
        const totalSizeMb = clubLogs.reduce((s, l) => s + l.totalSizeMb, 0);
        const lastUploadAt = clubLogs.reduce(
          (latest, l) => (l.uploadTimestamp > latest ? l.uploadTimestamp : latest),
          ''
        );
        clubs.push({
          clubName,
          sessionCount: clubLogs.length,
          fileCount,
          totalSizeMb: Math.round(totalSizeMb * 100) / 100,
          lastUploadAt,
        });
      });

      // Sort clubs by fileCount descending
      clubs.sort((a, b) => b.fileCount - a.fileCount);

      const totalFiles = clubs.reduce((s, c) => s + c.fileCount, 0);
      const totalSizeMb = Math.round(
        clubs.reduce((s, c) => s + c.totalSizeMb, 0) * 100
      ) / 100;

      eventsWithUploads.push({
        event,
        clubs,
        totalFiles,
        totalSizeMb,
        hasUploads: true,
      });
    }

    // Sort events with uploads by event date descending
    eventsWithUploads.sort((a, b) =>
      b.event.eventDate.localeCompare(a.event.eventDate)
    );

    // 6. Drive violation scan
    const violationsResult = scanAllViolations();
    const violations = (violationsResult.data ?? []) as FolderViolation[];

    // 7. System-wide totals
    const totalPhotos = eventsWithUploads.reduce((s, e) => s + e.totalFiles, 0);
    const totalSizeMb = Math.round(
      eventsWithUploads.reduce((s, e) => s + e.totalSizeMb, 0) * 100
    ) / 100;
    const allClubs = new Set<string>();
    eventsWithUploads.forEach((e) =>
      e.clubs.forEach((c) => allClubs.add(c.clubName))
    );

    const summary: SystemSummary = {
      generatedAt: new Date().toISOString(),
      dateFrom: dateFrom ?? null,
      dateTo: dateTo ?? null,
      eventsWithUploads,
      eventsWithoutUploads,
      violations,
      totalPhotos,
      totalSizeMb,
      totalClubs: allClubs.size,
    };

    return {
      status: ResultStatus.SUCCESS,
      message: `Summary: ${eventsWithUploads.length} active events, ` +
        `${eventsWithoutUploads.length} inactive, ` +
        `${violations.length} violation(s)`,
      data: summary,
    };
  } catch (err) {
    return {
      status: ResultStatus.ERROR,
      message: `Failed to generate summary: ${String(err)}`,
    };
  }
}

/**
 * Converts a SystemSummary to a CSV string for download.
 *
 * Produces two sections in one file:
 *   Section 1: Event upload details (club-level rows)
 *   Section 2: Events with no uploads
 *   Section 3: Naming violations
 *
 * The CSV is UTF-8 with BOM so Excel opens it correctly.
 */
export function summaryToCsv(summary: SystemSummary): string {
  const rows: string[] = [];
  const BOM = '\uFEFF'; // Excel UTF-8 BOM

  // Header metadata
  rows.push(csvRow(['湘舍动公益文件系统 — Upload Summary Report']));
  rows.push(csvRow([`Generated`, summary.generatedAt]));
  if (summary.dateFrom || summary.dateTo) {
    rows.push(csvRow([`Date filter`, `${summary.dateFrom ?? 'start'} → ${summary.dateTo ?? 'end'}`]));
  }
  rows.push(csvRow([])); // blank line

  // Section 1: Events with uploads
  rows.push(csvRow(['=== EVENTS WITH UPLOADS ===']));
  rows.push(csvRow([
    'Event Name', 'Event Date', 'Club', 'Sessions',
    'Photos', 'Size (MB)', 'Last Upload',
  ]));
  for (const es of summary.eventsWithUploads) {
    for (const club of es.clubs) {
      rows.push(csvRow([
        es.event.eventName,
        es.event.eventDate,
        club.clubName,
        String(club.sessionCount),
        String(club.fileCount),
        String(club.totalSizeMb),
        club.lastUploadAt,
      ]));
    }
  }
  rows.push(csvRow([]));

  // Section 2: Events with no uploads
  rows.push(csvRow(['=== EVENTS WITH NO UPLOADS ===']));
  rows.push(csvRow(['Event Name', 'Event Date', 'Folder Name']));
  for (const e of summary.eventsWithoutUploads) {
    rows.push(csvRow([e.eventName, e.eventDate, e.folderName]));
  }
  rows.push(csvRow([]));

  // Section 3: Naming violations
  rows.push(csvRow(['=== NAMING VIOLATIONS ===']));
  rows.push(csvRow(['Folder Name', 'Parent', 'Layer', 'Violation', 'Detected At']));
  for (const v of summary.violations) {
    rows.push(csvRow([
      v.folderName,
      v.parentFolderName,
      String(v.layer),
      v.violationType,
      v.detectedAt,
    ]));
  }

  return BOM + rows.join('\n');
}

/**
 * Builds the plain-text body for the exception notification email.
 * Sent when violations or inactive events are detected.
 */
export function buildExceptionEmailBody(summary: SystemSummary): string {
  const lines: string[] = [
    '湘舍动公益文件系统 — Exception Alert',
    `Generated: ${summary.generatedAt}`,
    '',
  ];

  if (summary.violations.length > 0) {
    lines.push(`== Naming Violations (${summary.violations.length}) ==`);
    for (const v of summary.violations) {
      lines.push(`  • [Layer ${v.layer}] "${v.folderName}" in "${v.parentFolderName}"`);
      lines.push(`    Reason: ${v.violationType}`);
    }
    lines.push('');
  }

  if (summary.eventsWithoutUploads.length > 0) {
    lines.push(`== Events With No Uploads (${summary.eventsWithoutUploads.length}) ==`);
    for (const e of summary.eventsWithoutUploads) {
      lines.push(`  • ${e.eventName} (${e.eventDate})`);
    }
    lines.push('');
  }

  lines.push('This is an automated message from 湘舍动公益文件系统.');
  return lines.join('\n');
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function groupLogsByEvent(
  logs: UploadLogRecord[]
): Map<string, UploadLogRecord[]> {
  const map = new Map<string, UploadLogRecord[]>();
  for (const log of logs) {
    if (!map.has(log.eventId)) map.set(log.eventId, []);
    map.get(log.eventId)!.push(log);
  }
  return map;
}

function groupLogsByClub(
  logs: UploadLogRecord[]
): Map<string, UploadLogRecord[]> {
  const map = new Map<string, UploadLogRecord[]>();
  for (const log of logs) {
    if (!map.has(log.clubName)) map.set(log.clubName, []);
    map.get(log.clubName)!.push(log);
  }
  return map;
}

/** Formats a row for CSV output, quoting fields that contain commas or quotes. */
function csvRow(fields: string[]): string {
  return fields
    .map((f) => {
      const s = String(f);
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    })
    .join(',');
}
