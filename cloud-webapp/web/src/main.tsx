import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { LanguageProvider } from './lib/i18n.js';
import { installGlobalErrorReporting } from './lib/reportError.js';
import './styles.css';

// Catch uncaught errors / unhandled promise rejections and ship them to the api
// so they reach the Cloud Monitoring email alert.
installGlobalErrorReporting();

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <LanguageProvider>
        <App />
      </LanguageProvider>
    </ErrorBoundary>
  </StrictMode>,
);
