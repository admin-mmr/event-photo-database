/**
 * i18n.tsx — tiny, dependency-free English / 中文 language toggle.
 *
 * Replaces the old "English · 中文" dual-label-everywhere approach with a single
 * language the user selects from the sticky header. Strings are *co-located*
 * with each component as `{ en, zh }` catalogs (see `useStrings`), so there is
 * no giant central translation file and many components can be migrated in
 * parallel without merge contention.
 *
 * Default language is inferred from `navigator.language` (zh* → 中文, else
 * English) and the user's explicit choice persists in localStorage.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Lang = 'en' | 'zh';

const STORAGE_KEY = 'eulb.lang';

/** Read the saved choice, else infer from the browser, else English. */
export function detectDefaultLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh') return saved;
  } catch {
    /* localStorage may be unavailable (private mode / webview) — ignore. */
  }
  const nav =
    typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en';
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

interface LangContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
}

const LangContext = createContext<LangContextValue>({
  lang: 'en',
  setLang: () => undefined,
});

export function LanguageProvider({ children }: { children: ReactNode }): JSX.Element {
  const [lang, setLang] = useState<Lang>(detectDefaultLang);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignore */
    }
    if (typeof document !== 'undefined') {
      document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    }
  }, [lang]);

  const value = useMemo<LangContextValue>(() => ({ lang, setLang }), [lang]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

/** Current language + setter. */
export function useLang(): LangContextValue {
  return useContext(LangContext);
}

/**
 * Pick the current-language slice of a co-located catalog:
 *
 *   const STR = { en: { title: 'Events' }, zh: { title: '活动' } };
 *   const t = useStrings(STR);
 *   return <h1>{t.title}</h1>;
 */
export function useStrings<T>(catalog: { en: T; zh: T }): T {
  return catalog[useLang().lang];
}

/**
 * Segmented EN / 中文 control for the sticky header. Always available; one tap
 * switches the whole UI.
 */
export function LangToggle(): JSX.Element {
  const { lang, setLang } = useLang();
  return (
    <div className="lang-toggle" role="group" aria-label="Language / 语言">
      <button
        type="button"
        className={lang === 'en' ? 'active' : ''}
        aria-pressed={lang === 'en'}
        onClick={() => setLang('en')}
      >
        EN
      </button>
      <button
        type="button"
        className={lang === 'zh' ? 'active' : ''}
        aria-pressed={lang === 'zh'}
        onClick={() => setLang('zh')}
      >
        中文
      </button>
    </div>
  );
}
