import { useEffect, useState } from 'react';
import type { User } from 'firebase/auth';
import { watchAuth } from './firebase.js';

export interface AuthState {
  user: User | null;
  /** True until the first auth callback fires. */
  loading: boolean;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ user: null, loading: true });

  useEffect(() => watchAuth((user) => setState({ user, loading: false })), []);

  return state;
}
