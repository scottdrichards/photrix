import React, { createContext, useContext, useReducer, useCallback, useEffect } from 'react';
import type { User, AuthResponse } from '../../types';
import { PhotoAPI } from '../../api';

interface AuthState {
  user: User | null;
  token: string | null;
  loading: boolean;
  error: string | null;
}

type AuthAction =
  | { type: 'LOGIN_START' }
  | { type: 'LOGIN_SUCCESS'; payload: { user: User; token: string } }
  | { type: 'LOGIN_ERROR'; payload: string }
  | { type: 'LOGOUT' };

const initialState: AuthState = {
  user: null,
  token: localStorage.getItem('photrix_token'),
  loading: false,
  error: null
};

function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case 'LOGIN_START':
      return { ...state, loading: true, error: null };
    case 'LOGIN_SUCCESS':
      return { ...state, loading: false, user: action.payload.user, token: action.payload.token };
    case 'LOGIN_ERROR':
      return { ...state, loading: false, error: action.payload };
    case 'LOGOUT':
      return { ...state, user: null, token: null };
    default:
      return state;
  }
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => void;
  api: PhotoAPI;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [state, dispatch] = useReducer(authReducer, initialState);
  const api = new PhotoAPI();
  if (state.token) api.setToken(state.token);

  // Rehydrate user from existing token on mount
  useEffect(() => {
    (async () => {
      if (state.token && !state.user) {
        try {
          const me = await api.getCurrentUser();
          if (me?.user) {
            dispatch({ type: 'LOGIN_SUCCESS', payload: { user: me.user, token: state.token! } });
          }
        } catch (e) {
          api.setToken(null);
          dispatch({ type: 'LOGOUT' });
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    dispatch({ type: 'LOGIN_START' });
    try {
      const res: AuthResponse = await api.login(username, password);
      api.setToken(res.token);
      dispatch({ type: 'LOGIN_SUCCESS', payload: { user: res.user, token: res.token } });
    } catch (e: any) {
      dispatch({ type: 'LOGIN_ERROR', payload: e.message || 'Login failed' });
    }
  }, [api]);

  const register = useCallback(async (username: string, email: string, password: string) => {
    dispatch({ type: 'LOGIN_START' });
    try {
      const res: AuthResponse = await api.register(username, email, password);
      api.setToken(res.token);
      dispatch({ type: 'LOGIN_SUCCESS', payload: { user: res.user, token: res.token } });
    } catch (e: any) {
      dispatch({ type: 'LOGIN_ERROR', payload: e.message || 'Registration failed' });
    }
  }, [api]);

  const logout = useCallback(() => {
    api.setToken(null);
    dispatch({ type: 'LOGOUT' });
  }, [api]);

  return (
    <AuthContext.Provider value={{ ...state, login, register, logout, api }}>
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
