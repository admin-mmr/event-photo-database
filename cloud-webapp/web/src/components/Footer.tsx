import { useStrings } from '../lib/i18n.js';

/**
 * App-wide footer carrying the source-code offer. When the matcher bundles an
 * AGPL-licensed component (YOLOv8 person detector), AGPL §13 requires that
 * users interacting with the service over the network be offered the complete
 * corresponding source of the running version. A public repo alone isn't the
 * offer — this visible, in-app link is. Keep it on every page (incl. sign-in).
 *
 * The deployed code must correspond to what's published here, so this points at
 * the repository the service is built from.
 */
const REPO_URL = 'https://github.com/admin-mmr/event-photo-database';

const STR = {
  en: {
    sourceCode: 'Source code',
    sourceNote:
      'This service runs open-source software. The complete source for the version running here is on GitHub.',
  },
  zh: {
    sourceCode: '源代码',
    sourceNote: '本服务运行开源软件。此处运行版本的完整源代码可在 GitHub 上获取。',
  },
};

export function Footer(): JSX.Element {
  const t = useStrings(STR);
  return (
    <footer className="app-footer">
      <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
        {t.sourceCode}
      </a>
      <span className="muted footer-note">{t.sourceNote}</span>
    </footer>
  );
}
