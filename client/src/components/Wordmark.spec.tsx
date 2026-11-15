import { act, fireEvent, render, screen } from "@testing-library/react";
import { Wordmark, WORDMARK_PLAY_MS } from "./Wordmark";

const setReducedMotion = (reduce: boolean) => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: reduce && query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
};

const scene = (container: HTMLElement) => container.querySelector('[data-part="scene"]');
const playKind = (container: HTMLElement) => scene(container)?.getAttribute("data-play");
const wordmark = () => screen.getByText("Photrix").parentElement!;
const finish = () => act(() => vi.advanceTimersByTime(WORDMARK_PLAY_MS));

describe("Wordmark", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setReducedMotion(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads as the plain word", () => {
    render(<Wordmark />);
    expect(screen.getByText("Photrix")).toBeTruthy();
  });

  it("arrives out of focus: the intro plays as soon as it appears", () => {
    const { container } = render(<Wordmark />);
    expect(playKind(container)).toBe("intro");
  });

  it("lets the intro finish before a hover can replay it", () => {
    const { container } = render(<Wordmark />);
    const intro = scene(container);
    fireEvent.mouseEnter(wordmark());
    fireEvent.click(wordmark());
    expect(scene(container)).toBe(intro);

    finish();
    fireEvent.mouseEnter(wordmark());
    expect(playKind(container)).toBe("replay");
    expect(scene(container)).not.toBe(intro);
  });

  it("replays on click once a replay has finished", () => {
    const { container } = render(<Wordmark />);
    finish();
    fireEvent.click(wordmark());
    const first = scene(container);
    fireEvent.click(wordmark());
    expect(scene(container)).toBe(first);

    finish();
    fireEvent.click(wordmark());
    expect(scene(container)).not.toBe(first);
    expect(playKind(container)).toBe("replay");
  });

  it("never plays under reduced motion", () => {
    setReducedMotion(true);
    const { container } = render(<Wordmark />);
    expect(playKind(container)).toBe("still");
    fireEvent.mouseEnter(wordmark());
    finish();
    fireEvent.click(wordmark());
    expect(playKind(container)).toBe("still");
  });
});
