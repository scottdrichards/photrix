import { afterEach, describe, expect, it } from "vitest";
import { initWindowControlsOverlay } from "./windowControlsOverlay";

const install = (visible: boolean) => {
  const target = Object.assign(new EventTarget(), { visible });
  Object.defineProperty(navigator, "windowControlsOverlay", { value: target, configurable: true });
  return target;
};

describe("initWindowControlsOverlay", () => {
  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).windowControlsOverlay;
    delete document.documentElement.dataset.wco;
  });

  it("does nothing where the API is missing", () => {
    expect(() => initWindowControlsOverlay()()).not.toThrow();
    expect(document.documentElement.dataset.wco).toBeUndefined();
  });

  it("marks the page while the overlay is visible and follows geometry changes", () => {
    const wco = install(true);
    const stop = initWindowControlsOverlay();
    expect(document.documentElement.dataset.wco).toBe("");
    wco.visible = false;
    wco.dispatchEvent(new Event("geometrychange"));
    expect(document.documentElement.dataset.wco).toBeUndefined();
    stop();
  });
});
