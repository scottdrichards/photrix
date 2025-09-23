import React, { createContext, useReducer, useContext, useCallback, PropsWithChildren } from 'react';
import type { Album, AlbumsResponse } from '../../types';
import { useAuth } from '../auth/AuthContext';

interface AlbumsState {
  albums: Album[];
  loading: boolean;
  error: string | null;
}

const initialState: AlbumsState = {
  albums: [],
  loading: false,
  error: null
};

type AlbumsAction =
  | { type: 'LOAD_START' }
  | { type: 'LOAD_SUCCESS'; payload: Album[] }
  | { type: 'LOAD_ERROR'; payload: string };

function albumsReducer(state: AlbumsState, action: AlbumsAction): AlbumsState {
  switch (action.type) {
    case 'LOAD_START':
      return { ...state, loading: true, error: null };
    case 'LOAD_SUCCESS':
      return { ...state, loading: false, albums: action.payload };
    case 'LOAD_ERROR':
      return { ...state, loading: false, error: action.payload };
    default:
      return state;
  }
}

interface AlbumsContextValue extends AlbumsState {
  refresh: () => Promise<void>;
}

const AlbumsContext = createContext<AlbumsContextValue | undefined>(undefined);

export const AlbumsProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const [state, dispatch] = useReducer(albumsReducer, initialState);
  const { api } = useAuth();

  const refresh = useCallback(async () => {
    dispatch({ type: 'LOAD_START' });
    try {
      const res: AlbumsResponse = await api.getAlbums();
      dispatch({ type: 'LOAD_SUCCESS', payload: res.albums });
    } catch (e: any) {
      dispatch({ type: 'LOAD_ERROR', payload: e.message || 'Failed to load albums' });
    }
  }, [api]);

  return (
    <AlbumsContext.Provider value={{ ...state, refresh }}>
      {children}
    </AlbumsContext.Provider>
  );
};

export function useAlbums() {
  const ctx = useContext(AlbumsContext);
  if (!ctx) throw new Error('useAlbums must be used within AlbumsProvider');
  return ctx;
}
