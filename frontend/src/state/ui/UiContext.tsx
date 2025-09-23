import React, { createContext, useReducer, useContext, PropsWithChildren } from 'react';

type Section = 'photos' | 'albums' | 'shared';
interface UiState { activeSection: Section; modals: Record<string, boolean>; }

type UiAction =
  | { type: 'NAVIGATE'; payload: Section }
  | { type: 'OPEN_MODAL'; payload: string }
  | { type: 'CLOSE_MODAL'; payload: string };

const initialState: UiState = { activeSection: 'photos', modals: {} };

function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case 'NAVIGATE':
      return { ...state, activeSection: action.payload };
    case 'OPEN_MODAL':
      return { ...state, modals: { ...state.modals, [action.payload]: true } };
    case 'CLOSE_MODAL':
      return { ...state, modals: { ...state.modals, [action.payload]: false } };
    default:
      return state;
  }
}

interface UiContextValue extends UiState {
  navigate: (s: Section) => void;
  openModal: (id: string) => void;
  closeModal: (id: string) => void;
}

const UiContext = createContext<UiContextValue | undefined>(undefined);

export const UiProvider: React.FC<PropsWithChildren> = ({ children }) => {
  const [state, dispatch] = useReducer(uiReducer, initialState);
  const navigate = (s: Section) => dispatch({ type: 'NAVIGATE', payload: s });
  const openModal = (id: string) => dispatch({ type: 'OPEN_MODAL', payload: id });
  const closeModal = (id: string) => dispatch({ type: 'CLOSE_MODAL', payload: id });
  return (
    <UiContext.Provider value={{ ...state, navigate, openModal, closeModal }}>
      {children}
    </UiContext.Provider>
  );
};

export function useUi() {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error('useUi must be inside UiProvider');
  return ctx;
}
