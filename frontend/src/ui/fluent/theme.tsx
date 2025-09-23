import React from 'react';
import { FluentProvider, webDarkTheme } from '@fluentui/react-components';

export const AppThemeProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  return <FluentProvider theme={webDarkTheme} style={{ minHeight: '100vh' }}>{children}</FluentProvider>;
};
