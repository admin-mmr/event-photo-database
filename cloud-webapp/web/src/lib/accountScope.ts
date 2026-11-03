/**
 * accountScope.ts — which account the signed-in pages are rendering for.
 *
 * The App layout renders every signed-in page through `<Outlet>` KEYED by the
 * uid, so switching accounts in one tab (a guest signing in with Google — a new
 * uid unless the link keeps it — or signing out and handing the phone over)
 * remounts the page instead of leaving the previous person's state on screen.
 * That state is not harmless: on 2026-11-03 a Find-Me tab kept a guest's results
 * after the switch, the new account cast 45 votes on the guest's search, and its
 * re-runs of the guest's saved selfies 404'd ("Reference photo not found").
 *
 * The same uid is handed down as outlet context so per-tab caches (findmeCache)
 * can be scoped to it — a remount alone would just restore the old cache.
 */

import { useOutletContext } from 'react-router-dom';

export interface AccountScope {
  uid: string;
}

/** The uid the current page belongs to; '' outside the signed-in layout. */
export function useAccountUid(): string {
  return useOutletContext<AccountScope | undefined>()?.uid ?? '';
}
