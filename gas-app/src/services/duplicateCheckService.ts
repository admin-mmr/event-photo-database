import { ClubFolderFileEntry } from './driveService';

/**
 * DuplicateCheckService — client-safe duplicate detection logic.
 *
 * Compares a list of files the user intends to upload against the files
 * already stored in the club subfolder for the selected event.
 *
 * Matching strategy: filename (case-insensitive) + exact byte size.
 *   - Filename alone is insufficient: two events may share a camera roll file name.
 *   - Size alone is insufficient: different photos can have the same size.
 *   - Combined, a match is very unlikely to be coincidental.
 *   - We intentionally exclude lastModified because browser timestamps are
 *     unreliable across OS/filesystem combinations, and Drive updates mtime on
 *     upload anyway — making a three-way match nearly impossible.
 *
 * Design notes:
 *   - This service is GAS-free (no global APIs) so it can run in the browser
 *     as well as in unit tests without GAS mocks.
 *   - Called client-side after serverGetClubFolderTree returns the existing
 *     file list; the result drives the duplicate-resolution UI (Step 3.5).
 *   - Duplicate overwrite is supported: the user can choose to include
 *     flagged files anyway; the upload service will write them into the same
 *     batch folder alongside the original copies.
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Minimal description of a file the user has selected for upload.
 * Mirrors the subset of the browser File object we need for comparison.
 */
export interface IncomingFileInfo {
  readonly name: string;
  readonly sizeBytes: number; // File.size
}

/**
 * A single duplicate match: one incoming file paired with its existing counterpart.
 */
export interface DuplicateMatch {
  readonly incomingFile: IncomingFileInfo;
  readonly matchedFile: Pick<ClubFolderFileEntry, 'name' | 'fileId' | 'sizeBytes' | 'batchFolderName'>;
}

/**
 * Result of a full duplicate check run.
 */
export interface DuplicateCheckResult {
  /** Files with no match — safe to upload as-is. */
  readonly accepted: ReadonlyArray<IncomingFileInfo>;
  /** Files that match an existing file by name+size. */
  readonly duplicates: ReadonlyArray<DuplicateMatch>;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Partitions `incoming` into accepted files and duplicates.
 *
 * A file is a duplicate if any existing entry matches on both:
 *   1. Filename — case-insensitive comparison
 *   2. Byte size — exact equality
 *
 * If the same incoming file matches multiple existing entries (e.g. the same
 * photo was uploaded in two separate sessions), only the first match is reported.
 *
 * @param incoming  Files selected by the user in the browser file picker
 * @param existing  Files already in the club folder (from getClubFolderTree)
 */
export function checkForDuplicates(
  incoming: IncomingFileInfo[],
  existing: ClubFolderFileEntry[]
): DuplicateCheckResult {
  const accepted: IncomingFileInfo[] = [];
  const duplicates: DuplicateMatch[] = [];

  for (const inFile of incoming) {
    const nameLower = inFile.name.toLowerCase();
    const match = existing.find(
      (ex) => ex.name.toLowerCase() === nameLower && ex.sizeBytes === inFile.sizeBytes
    );

    if (match) {
      duplicates.push({
        incomingFile: inFile,
        matchedFile: {
          name: match.name,
          fileId: match.fileId,
          sizeBytes: match.sizeBytes,
          batchFolderName: match.batchFolderName,
        },
      });
    } else {
      accepted.push(inFile);
    }
  }

  return { accepted, duplicates };
}

/**
 * Merges user decisions about duplicates back into a single upload list.
 *
 * @param accepted    Files that passed duplicate check (always included)
 * @param duplicates  Files that matched an existing entry
 * @param overwrite   Set of duplicate filenames the user chose to include anyway
 *                    (empty = skip all duplicates)
 *
 * @returns Final list of files to upload, plus count of skipped duplicates.
 */
export function resolveUploadList(
  accepted: IncomingFileInfo[],
  duplicates: DuplicateMatch[],
  overwrite: Set<string>
): { toUpload: IncomingFileInfo[]; skippedCount: number } {
  const toUpload: IncomingFileInfo[] = [...accepted];
  let skippedCount = 0;

  for (const dup of duplicates) {
    if (overwrite.has(dup.incomingFile.name)) {
      toUpload.push(dup.incomingFile);
    } else {
      skippedCount++;
    }
  }

  return { toUpload, skippedCount };
}
