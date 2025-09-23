import React, { createContext, useReducer, useContext, useCallback, PropsWithChildren } from 'react';
import type { Photo, PhotosResponse } from '../../types';
import { useAuth } from '../auth/AuthContext';

interface ViewportBounds { minLat: number; maxLat: number; minLng: number; maxLng: number; }
interface PhotosState {
  photos: Photo[];
  filteredPhotos: Photo[];
  loading: boolean;
  error: string | null;
  search: string;
  bounds?: ViewportBounds;
}

const initialState: PhotosState = {
  photos: [],
  filteredPhotos: [],
  loading: false,
  error: null,
  search: ''
};

type PhotosAction =
  | { type: 'LOAD_START' }
  | { type: 'LOAD_SUCCESS'; payload: Photo[] }
  | { type: 'LOAD_ERROR'; payload: string }
  | { type: 'SET_SEARCH'; payload: string }
  | { type: 'SET_BOUNDS'; payload: ViewportBounds | undefined };

function applyFiltering(state: PhotosState): PhotosState {
  const { photos, search, bounds } = state;
  let result = photos;
  if (search) {
    const q = search.toLowerCase();
    result = result.filter(p => p.original_name.toLowerCase().includes(q));
  }
  if (bounds) {
    const before = result.length;
    result = result.filter(p =>
      p.latitude != null && p.longitude != null &&
      p.latitude! >= bounds.minLat && p.latitude! <= bounds.maxLat &&
      p.longitude! >= bounds.minLng && p.longitude! <= bounds.maxLng
    );
    if (before !== result.length) {
      console.debug(`Filtered by bounds: ${before} -> ${result.length}`);
    } else {
      console.debug('Bounds filter applied; count unchanged');
    }
  }
  return { ...state, filteredPhotos: result };
}

function photosReducer(prev: PhotosState, action: PhotosAction): PhotosState {
  switch (action.type) {
    case 'LOAD_START':
      return { ...prev, loading: true, error: null };
    case 'LOAD_SUCCESS':
      return applyFiltering({ ...prev, loading: false, photos: action.payload });
    case 'LOAD_ERROR':
      return { ...prev, loading: false, error: action.payload };
    case 'SET_SEARCH':
      return applyFiltering({ ...prev, search: action.payload });
    case 'SET_BOUNDS':
      return applyFiltering({ ...prev, bounds: action.payload });
    default:
      return prev;
  }
}

interface PhotosContextValue extends PhotosState {
  refresh: (query?: string) => Promise<void>;
  setSearch: (value: string) => void;
  setViewportBounds: (b: ViewportBounds | undefined) => void;
}

const PhotosContext = createContext<PhotosContextValue | undefined>(undefined);

export const PhotosProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const [state, dispatch] = useReducer(photosReducer, initialState);
  const { api } = useAuth();

  const refresh = useCallback(async (query?: string) => {
    dispatch({ type: 'LOAD_START' });
    try {
      const params: Record<string, string> = {};
      if (query) params.search = query;
      const res: PhotosResponse = await api.getPhotos(params);
      dispatch({ type: 'LOAD_SUCCESS', payload: res.photos });
    } catch (e: any) {
      dispatch({ type: 'LOAD_ERROR', payload: e.message || 'Failed to load photos' });
    }
  }, [api]);

  const setSearch = useCallback((value: string) => {
    dispatch({ type: 'SET_SEARCH', payload: value });
  }, []);

  const setViewportBounds = useCallback((b: ViewportBounds | undefined) => {
    // Debug: log bounds updates (can be removed later)
    if (b) {
      console.debug('Viewport bounds updated', b);
    } else {
      console.debug('Viewport bounds cleared');
    }
    dispatch({ type: 'SET_BOUNDS', payload: b });
  }, []);

  return (
    <PhotosContext.Provider value={{ ...state, refresh, setSearch, setViewportBounds }}>
      {children}
    </PhotosContext.Provider>
  );
};

export function usePhotos() {
  const ctx = useContext(PhotosContext);
  if (!ctx) throw new Error('usePhotos must be used within PhotosProvider');
  return ctx;
}
