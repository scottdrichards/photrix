import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { libraryTitle, setSelectionBadge, setViewerThemeColor, VIEWER_THEME_COLOR } from "./appChrome";

describe("appChrome", () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#f7f7f7">';
    document.documentElement.dataset.theme = "light";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blacks the title bar while the viewer is open and restores the page colour after", () => {
    const meta = () => document.querySelector('meta[name="theme-color"]')!.getAttribute("content");
    setViewerThemeColor(true);
    expect(meta()).toBe(VIEWER_THEME_COLOR);
    setViewerThemeColor(false);
    expect(meta()).toBe("#f7f7f7");
    document.documentElement.dataset.theme = "dark";
    setViewerThemeColor(false);
    expect(meta()).toBe("#11161d");
  });

  it("badges the app icon with the selection count and clears it at zero", () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined);
    const clearAppBadge = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { setAppBadge, clearAppBadge });
    setSelectionBadge(3);
    expect(setAppBadge).toHaveBeenCalledWith(3);
    setSelectionBadge(0);
    expect(clearAppBadge).toHaveBeenCalled();
  });

  it("does nothing where the Badging API is missing", () => {
    Object.assign(navigator, { setAppBadge: undefined, clearAppBadge: undefined });
    expect(() => setSelectionBadge(2)).not.toThrow();
  });

  it("titles the idle window with the library size", () => {
    expect(libraryTitle(null)).toBe("Photrix");
    expect(libraryTitle(1)).toBe("Photrix – 1 photo");
    expect(libraryTitle(163840)).toBe("Photrix – 163,840 photos");
  });
});
