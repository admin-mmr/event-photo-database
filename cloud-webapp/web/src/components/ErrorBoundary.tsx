/**
 * ErrorBoundary.tsx — catches render-time errors that the window 'error' event
 * does not see in production React, reports them to the api (so ops is alerted),
 * and shows a minimal fallback instead of a blank white screen.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportClientError } from '../lib/reportError.js';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError('react_render', error.message || 'React render error', {
      stack: error.stack,
      context: { componentStack: info.componentStack?.slice(0, 4000) },
    });
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'system-ui, sans-serif' }}>
          <h1 style={{ fontSize: '1.25rem' }}>Something went wrong</h1>
          <p>Please reload the page. If it keeps happening, the team has been notified.</p>
          <button type="button" onClick={() => window.location.reload()} style={{ marginTop: '1rem' }}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
