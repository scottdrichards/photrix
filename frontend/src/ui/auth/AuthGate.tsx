import React from 'react';
import { useAuth } from '../../state/auth/AuthContext';
import { AuthLoginRegister } from './LoginRegister';

export const AuthGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  if (!user) return <AuthLoginRegister />;
  return <>{children}</>;
};
