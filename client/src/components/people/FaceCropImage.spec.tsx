import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterFace } from "../../api/types";

vi.mock("./faceCropPlaceholder", () => ({
  peekFaceCropPlaceholder: () => null,
  makeFaceCropPlaceholder: () => Promise.resolve(null),
}));

/** IntersectionObservers by rootMargin, so a test can move the image in or out of a band. */
let observers: Array<{ margin: string; callback: IntersectionObserverCallback; targets: Element[] }> =
  [];

class FakeIntersectionObserver {
  private entry: (typeof observers)[number];
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.entry = { margin: options?.rootMargin ?? "", callback, targets: [] };
    observers.push(this.entry);
  }
  observe = (target: Element) => this.entry.targets.push(target);
  unobserve = (target: Element) => {
    this.entry.targets = this.entry.targets.filter((other) => other !== target);
  };
  disconnect = () => {
    this.entry.targets = [];
  };
}

/** Moves every watched element into or out of all bands: a scroll past. */
const scroll = (isIntersecting: boolean) =>
  act(() => {
    for (const { callback, targets } of observers) {
      callback(
        targets.map((target) => ({ target, isIntersecting }) as IntersectionObserverEntry),
        {} as IntersectionObserver,
      );
    }
  });

const face = {
  faceId: 1,
  photo: { path: "/2026/party.heic", name: "party.heic" },
  box: { x: 0.5, y: 0.25, width: 0.1, height: 0.2 },
} as unknown as ClusterFace;

const BLANK = /^data:image\/gif/;

beforeEach(() => {
  observers = [];
  vi.resetModules();
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const renderCrop = async (loading: "lazy" | "eager") => {
  const { FaceCropImage } = await import("./FaceCropImage");
  render(<FaceCropImage face={face} alt="party.heic" loading={loading} />);
  return screen.getByAltText("party.heic");
};

describe("FaceCropImage (feedback #171)", () => {
  it("doesn't ask for a lazy crop until it is close to the viewport", async () => {
    const img = await renderCrop("lazy");
    expect(img.getAttribute("src")).toMatch(BLANK);

    scroll(true);
    expect(img.getAttribute("src")).toContain("crop=");
  });

  it("gives the request up when the crop scrolls away before it loads", async () => {
    const img = await renderCrop("lazy");
    scroll(true);
    scroll(false);
    expect(img.getAttribute("src")).toMatch(BLANK);
  });

  it("keeps a crop that already loaded when it scrolls away", async () => {
    const img = await renderCrop("lazy");
    scroll(true);
    fireEvent.load(img);
    scroll(false);
    expect(img.getAttribute("src")).toContain("crop=");
  });

  it("asks for an eager crop straight away", async () => {
    const img = await renderCrop("eager");
    expect(img.getAttribute("src")).toContain("crop=");
  });
});
