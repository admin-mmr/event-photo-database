/**
 * galleryFolders.ts — the gallery's club/tag filter menus, derived from the
 * event's `galleryFolders` (per-(club, tag) photo counts the indexer writes).
 */
import type { GalleryFolder } from '@cloud-webapp/shared';

export interface FolderOption {
  value: string;
  count: number;
}

/** One entry per club, summed over its tags, in the indexer's (code point) order. */
export function clubOptions(folders: GalleryFolder[]): FolderOption[] {
  const byClub = new Map<string, number>();
  for (const f of folders) byClub.set(f.clubName, (byClub.get(f.clubName) ?? 0) + f.count);
  return [...byClub].map(([value, count]) => ({ value, count }));
}

/** The club's tags. Photos filed directly under the club (tag '') count toward
 *  the club but can't be picked on their own — "All tags" covers them. */
export function tagOptions(folders: GalleryFolder[], club: string): FolderOption[] {
  return folders
    .filter((f) => f.clubName === club && f.tag)
    .map((f) => ({ value: f.tag, count: f.count }));
}
