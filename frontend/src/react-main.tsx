import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppProviders } from './state/AppProviders';
import { AppShell } from './ui/AppShell';
import { AppThemeProvider } from './ui/fluent/theme';

const rootEl = document.getElementById('root');
if (rootEl) {
  const root = createRoot(rootEl);
  root.render(
    <React.StrictMode>
      <AppThemeProvider>
        <AppProviders>
          <AppShell />
        </AppProviders>
      </AppThemeProvider>
    </React.StrictMode>
  );
}
