import type { GalleryFolder } from '@cloud-webapp/shared';
import { clubOptions, tagOptions, type FolderOption } from '../lib/galleryFolders.js';
import { useStrings } from '../lib/i18n.js';

/** Upload links with no tag file under this folder (linkStore DEFAULT_TAG). */
const DEFAULT_TAG = 'ALL';

const STR = {
  en: {
    clubLabel: 'Filter by club',
    tagLabel: 'Filter by tag',
    allClubs: 'All clubs',
    allTags: 'All tags',
    noTag: 'No tag',
  },
  zh: {
    clubLabel: '按俱乐部筛选',
    tagLabel: '按标签筛选',
    allClubs: '全部俱乐部',
    allTags: '全部标签',
    noTag: '无标签',
  },
};

/** Keep a selected value in the menu even when the folder list doesn't know it
 *  (an event not re-indexed yet, or a shared link to a club that has since
 *  emptied), so the user can always see and clear the active filter. */
function withSelected(options: FolderOption[], selected: string): FolderOption[] {
  if (!selected || options.some((o) => o.value === selected)) return options;
  return [...options, { value: selected, count: 0 }];
}

interface FolderFilterProps {
  folders: GalleryFolder[];
  club: string;
  tag: string;
  onChange: (club: string, tag: string) => void;
}

/**
 * Club, then tag, dropdowns for the gallery toolbar. "All" is the empty value
 * for both, so the default view is the whole event. Choosing a club clears the
 * tag (tags belong to a club); the tag menu appears only once a club with more
 * than one tag is chosen — a single tag would just repeat the club. Renders
 * nothing for an event with no club folders.
 */
export function FolderFilter({ folders, club, tag, onChange }: FolderFilterProps): JSX.Element | null {
  const t = useStrings(STR);
  const clubs = withSelected(clubOptions(folders), club);
  const clubTags = club ? withSelected(tagOptions(folders, club), tag) : [];
  const tags = clubTags.length > 1 || tag ? clubTags : [];
  if (clubs.length === 0) return null;

  const label = (o: FolderOption, name: string): string => (o.count ? `${name} (${o.count})` : name);
  return (
    <>
      <label className="page-size">
        <span className="sr-only">{t.clubLabel}</span>
        <select
          className="page-size-select"
          value={club}
          onChange={(e) => onChange(e.target.value, '')}
          aria-label={t.clubLabel}
        >
          <option value="">{t.allClubs}</option>
          {clubs.map((o) => (
            <option key={o.value} value={o.value}>
              {label(o, o.value)}
            </option>
          ))}
        </select>
      </label>
      {tags.length > 0 && (
        <label className="page-size">
          <span className="sr-only">{t.tagLabel}</span>
          <select
            className="page-size-select"
            value={tag}
            onChange={(e) => onChange(club, e.target.value)}
            aria-label={t.tagLabel}
          >
            <option value="">{t.allTags}</option>
            {tags.map((o) => (
              <option key={o.value} value={o.value}>
                {label(o, o.value === DEFAULT_TAG ? t.noTag : o.value)}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}
