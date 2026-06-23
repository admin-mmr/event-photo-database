/**
 * useSession.ts — resolves the signed-in user's control-plane role for
 * role-aware navigation.
 *
 * The Firebase user only tells us email / anonymous; the role lives in the
 * Users sheet, so we fetch it from GET /api/me. Anonymous guests (and signed-out
 * users) have no control-plane role, so we skip the call and report null.
 *
 * This drives which menu items are SHOWN; it is not a security boundary — every
 * privileged API route enforces its own role guard.
 */

import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import type { MeResponse, Role } from '@cloud-webapp/shared';
import { apiGet } from './api.js';

export interface Session {
  /** Control-plane role, or null for a member / guest with no role. */
  role: Role | null;
  /** Club normalizedName for a club_admin; '' otherwise. */
  clubId: string;
  /** True while /api/me is in flight (false once resolved or skipped). */
  loading: boolean;
}

const EMPTY: Session = { role: null, clubId: '', loading: false };

export function useSession(user: User | null): Session {
  // Start in "loading" only when there's a non-anonymous user whose role we'll
  // actually fetch, so the menu doesn't flicker for guests/signed-out.
  const willFetch = Boolean(user) && !user?.isAnonymous;
  const [session, setSession] = useState<Session>({ ...EMPTY, loading: willFetch });

  useEffect(() => {
    if (!user || user.isAnonymous) {
      setSession(EMPTY);
      return;
    }
    let cancelled = false;
    setSession((s) => ({ ...s, loading: true }));
    apiGet<MeResponse>('/api/me')
      .then((r) => {
        if (!cancelled) setSession({ role: r.role, clubId: r.clubId, loading: false });
      })
      .catch(() => {
        // Network/permission failure → treat as no role (menu shows the
        // everyone-items only). The API still guards the real pages.
        if (!cancelled) setSession(EMPTY);
      });
    return () => {
      cancelled = true;
    };
  }, [user]);

  return session;
}
