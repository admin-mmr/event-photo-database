/**
 * userName.ts — the searcher's display name, remembered for the session.
 *
 * Captured once on the sign-in screen (guest flow) or on the first Find Me
 * consent, then reused so we never ask again on later pages/events. Stored in
 * localStorage so a reload (or the iOS share/download bounce) keeps it. It is
 * NOT a secret — just a label shown to event organizers — so localStorage is
 * fine. Cleared on sign-out.
 */

const KEY = 'eulb.name';

/** The remembered name, or '' if none / storage is unavailable. */
export function getStoredName(): string {
  try {
    return (localStorage.getItem(KEY) ?? '').trim();
  } catch {
    return '';
  }
}

/** Remember (or, with an empty value, forget) the searcher's name. */
export function setStoredName(name: string): void {
  try {
    const v = name.trim();
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode / webview — ignore. */
  }
}

/** Forget the remembered name (called on sign-out / exit guest). */
export function clearStoredName(): void {
  setStoredName('');
}
