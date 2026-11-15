import { act, fireEvent, render, screen } from "@testing-library/react";
import { Wordmark, WORDMARK_INTRO_DELAY_MS, WORDMARK_PLAY_MS } from "./Wordmark";

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

const letters = (container: HTMLElement) => container.querySelector('[data-part="rest"]');
const isPlaying = (container: HTMLElement) =>
  letters(container)?.hasAttribute("data-playing");
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

  it("sits still, then plays a couple of seconds after it appears", () => {
    const { container } = render(<Wordmark />);
    expect(isPlaying(container)).toBe(false);
    act(() => vi.advanceTimersByTime(WORDMARK_INTRO_DELAY_MS - 1));
    expect(isPlaying(container)).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(isPlaying(container)).toBe(true);
  });

  it("plays at once on hover, without waiting for the intro", () => {
    const { container } = render(<Wordmark />);
    fireEvent.mouseEnter(screen.getByText("Photrix").parentElement!);
    expect(isPlaying(container)).toBe(true);
    const played = letters(container);
    act(() => vi.advanceTimersByTime(WORDMARK_INTRO_DELAY_MS));
    expect(letters(container)).toBe(played);
  });

  it("lets a play finish, then replays on hover or click", () => {
    const { container } = render(<Wordmark />);
    const wordmark = screen.getByText("Photrix").parentElement!;
    act(() => vi.advanceTimersByTime(WORDMARK_INTRO_DELAY_MS));
    const first = letters(container);

    fireEvent.mouseEnter(wordmark);
    fireEvent.click(wordmark);
    expect(letters(container)).toBe(first);

    finish();
    fireEvent.mouseEnter(wordmark);
    const second = letters(container);
    expect(second).not.toBe(first);

    finish();
    fireEvent.click(wordmark);
    expect(letters(container)).not.toBe(second);
  });

  it("never plays under reduced motion", () => {
    setReducedMotion(true);
    const { container } = render(<Wordmark />);
    fireEvent.mouseEnter(screen.getByText("Photrix").parentElement!);
    act(() => vi.advanceTimersByTime(WORDMARK_INTRO_DELAY_MS * 2));
    expect(isPlaying(container)).toBe(false);
  });
});
