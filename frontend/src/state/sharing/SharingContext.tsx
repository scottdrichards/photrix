import React, { createContext, useReducer, useContext, useCallback, PropsWithChildren } from 'react';
import type { Share, SharesResponse } from '../../types';
import { useAuth } from '../auth/AuthContext';

interface SharingState {
  created: Share[];
  received: Share[];
  loading: boolean;
  error: string | null;
}

const initialState: SharingState = {
  created: [],
  received: [],
  loading: false,
  error: null
};

type SharingAction =
  | { type: 'LOAD_START' }
  | { type: 'LOAD_SUCCESS'; payload: { created: Share[]; received: Share[] } }
  | { type: 'LOAD_ERROR'; payload: string };

function sharingReducer(state: SharingState, action: SharingAction): SharingState {
  switch (action.type) {
    case 'LOAD_START':
      return { ...state, loading: true, error: null };
    case 'LOAD_SUCCESS':
      return { ...state, loading: false, created: action.payload.created, received: action.payload.received };
    case 'LOAD_ERROR':
      return { ...state, loading: false, error: action.payload };
    default:
      return state;
  }
}

interface SharingContextValue extends SharingState {
  refresh: () => Promise<void>;
}

const SharingContext = createContext<SharingContextValue | undefined>(undefined);

export const SharingProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const [state, dispatch] = useReducer(sharingReducer, initialState);
  const { api } = useAuth();

  const refresh = useCallback(async () => {
    dispatch({ type: 'LOAD_START' });
    try {
      const createdRes: SharesResponse = await api.getCreatedShares();
      const receivedRes: SharesResponse = await api.getReceivedShares();
      dispatch({ type: 'LOAD_SUCCESS', payload: { created: createdRes.shares, received: receivedRes.shares } });
    } catch (e: any) {
      dispatch({ type: 'LOAD_ERROR', payload: e.message || 'Failed to load sharing data' });
    }
  }, [api]);

  return (
    <SharingContext.Provider value={{ ...state, refresh }}>
      {children}
    </SharingContext.Provider>
  );
};

export function useSharing() {
  const ctx = useContext(SharingContext);
  if (!ctx) throw new Error('useSharing must be used within SharingProvider');
  return ctx;
}
