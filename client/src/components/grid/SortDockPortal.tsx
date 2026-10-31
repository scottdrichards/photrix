import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Feedback #122/#123 put SortControl in the same floating dock as ViewToggle
// (see TopRailPortal), but that made the two boxes stack instead of sit in a
// row (each is its own block-level box; ViewToggle's own display:flex only
// governs its own children, not how it sits next to a sibling), and — a
// user comment, not a queue item — SortControl's clicks landed nowhere,
// since nothing in that chain set pointer-events back to `auto` for it.
// Anchoring it to its own dock, pinned to the bottom-right instead of
// bottom-center, sidesteps both: it never shares a box with ViewToggle, so
// there's no shared width to fight over, and its own CSS is free to set its
// own pointer-events without depending on a sibling's wrapper for it.
const SortDockContext = createContext<HTMLElement | null>(null);

type SortDockProviderProps = {
  host: HTMLElement | null;
  children: ReactNode;
};

export const SortDockProvider = ({ host, children }: SortDockProviderProps) => (
  <SortDockContext.Provider value={host}>{children}</SortDockContext.Provider>
);

export const SortDockPortal = ({ children }: { children: ReactNode }) => {
  const host = useContext(SortDockContext);
  return host ? createPortal(children, host) : null;
};
