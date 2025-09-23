import React from 'react';
import { Header } from './layout/Header';
import { MainView } from './layout/MainView';
import { AuthGate } from './auth/AuthGate';

export const AppShell: React.FC = () => (
  <AuthGate>
    <div className="app-shell">
      <Header />
      <MainView />
    </div>
  </AuthGate>
);
