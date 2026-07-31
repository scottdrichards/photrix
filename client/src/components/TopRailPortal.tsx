import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

const TopRailPortalContext = createContext<HTMLElement | null>(null);

type TopRailPortalProviderProps = {
  host: HTMLElement | null;
  children: ReactNode;
};

export const TopRailPortalProvider = ({ host, children }: TopRailPortalProviderProps) => (
  <TopRailPortalContext.Provider value={host}>{children}</TopRailPortalContext.Provider>
);

export const TopRailPortal = ({ children }: { children: ReactNode }) => {
  const host = useContext(TopRailPortalContext);
  return host ? createPortal(children, host) : null;
};
