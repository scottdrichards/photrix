import { act, fireEvent, render, screen } from "@testing-library/react";
import { Wordmark } from "./Wordmark";
import { playMs } from "./wordmarkFocus";

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

const scene = (container: HTMLElement) => container.querySelector('[data-part="scene"]')!;
const playKind = (container: HTMLElement) => scene(container).getAttribute("data-play");
const runs = (container: HTMLElement) =>
  Number(scene(container).getAttribute("data-run"));
const wordmark = () => screen.getByText("Photrix").parentElement!;
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

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
    fireEvent.mouseEnter(wordmark());
    fireEvent.click(wordmark());
    expect(playKind(container)).toBe("intro");

    wait(playMs("intro"));
    fireEvent.mouseEnter(wordmark());
    expect(playKind(container)).toBe("replay");
    expect(runs(container)).toBe(1);
  });

  it("ignores clicks mid-replay, then replays once it has finished", () => {
    const { container } = render(<Wordmark />);
    wait(playMs("intro"));
    fireEvent.click(wordmark());
    fireEvent.click(wordmark());
    expect(runs(container)).toBe(1);

    wait(playMs("replay"));
    fireEvent.click(wordmark());
    expect(runs(container)).toBe(2);
  });

  it("never plays under reduced motion", () => {
    setReducedMotion(true);
    const { container } = render(<Wordmark />);
    expect(playKind(container)).toBe("still");
    fireEvent.mouseEnter(wordmark());
    wait(playMs("intro"));
    fireEvent.click(wordmark());
    expect(playKind(container)).toBe("still");
  });
});
