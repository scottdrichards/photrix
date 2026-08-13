import {
  __resetTilePlaybackCoordinatorForTests,
  acquirePlaybackSlot,
  isAmbientPlaybackAllowed,
  isPlaybackAllowed,
  registerAmbientCandidate,
} from "./tilePlaybackCoordinator";

const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

const setMatchMedia = (matches: (query: string) => boolean) => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matches(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
};

describe("tilePlaybackCoordinator", () => {
  beforeEach(() => {
    __resetTilePlaybackCoordinatorForTests();
    setVisibility("visible");
    setMatchMedia(() => false);
  });

  afterEach(() => {
    __resetTilePlaybackCoordinatorForTests();
    vi.useRealTimers();
  });

  it("only lets one video tile play at a time, stopping the previous one", () => {
    const stopFirst = vi.fn();
    const stopSecond = vi.fn();

    expect(acquirePlaybackSlot("video", stopFirst)).not.toBeNull();
    expect(acquirePlaybackSlot("video", stopSecond)).not.toBeNull();

    expect(stopFirst).toHaveBeenCalledTimes(1);
    expect(stopSecond).not.toHaveBeenCalled();
  });

  it("does not evict anyone when the caller opts out of preempting", () => {
    const stopFirst = vi.fn();
    acquirePlaybackSlot("video", stopFirst);

    expect(acquirePlaybackSlot("video", vi.fn(), { preempt: false })).toBeNull();
    expect(stopFirst).not.toHaveBeenCalled();
  });

  it("allows two ambient clips but no more", () => {
    acquirePlaybackSlot("ambient", vi.fn());
    acquirePlaybackSlot("ambient", vi.fn());

    expect(acquirePlaybackSlot("ambient", vi.fn(), { preempt: false })).toBeNull();
  });

  it("frees the slot when a holder releases, without stopping it", () => {
    const stop = vi.fn();
    const release = acquirePlaybackSlot("video", stop);
    release?.();

    const stopNext = vi.fn();
    expect(acquirePlaybackSlot("video", stopNext, { preempt: false })).not.toBeNull();
    expect(stop).not.toHaveBeenCalled();
  });

  it("survives a stop callback that releases its own slot", () => {
    let release: (() => void) | null = null;
    const stop = vi.fn(() => release?.());
    release = acquirePlaybackSlot("video", stop);

    expect(() => acquirePlaybackSlot("video", vi.fn())).not.toThrow();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("stops everything and refuses new playback while the tab is hidden", () => {
    const stopVideo = vi.fn();
    const stopAmbient = vi.fn();
    acquirePlaybackSlot("video", stopVideo);
    acquirePlaybackSlot("ambient", stopAmbient);

    setVisibility("hidden");

    expect(stopVideo).toHaveBeenCalledTimes(1);
    expect(stopAmbient).toHaveBeenCalledTimes(1);
    expect(isPlaybackAllowed()).toBe(false);
    expect(acquirePlaybackSlot("video", vi.fn())).toBeNull();
  });

  it("disables the idle rotation under prefers-reduced-motion", () => {
    setMatchMedia((query) => query.includes("prefers-reduced-motion"));

    expect(isAmbientPlaybackAllowed()).toBe(false);
    // Deliberate hover playback is unaffected.
    expect(isPlaybackAllowed()).toBe(true);
  });

  it("wakes registered candidates on a tick and stops once they unregister", () => {
    vi.useFakeTimers();
    const play = vi.fn();
    const unregister = registerAmbientCandidate(play);

    vi.advanceTimersByTime(10_000);
    expect(play).toHaveBeenCalled();

    unregister();
    play.mockClear();
    vi.advanceTimersByTime(30_000);
    expect(play).not.toHaveBeenCalled();
  });

  it("does not wake candidates while the tab is hidden", () => {
    vi.useFakeTimers();
    const play = vi.fn();
    registerAmbientCandidate(play);
    setVisibility("hidden");

    vi.advanceTimersByTime(30_000);

    expect(play).not.toHaveBeenCalled();
  });

  it("never wakes the same ambient candidate on two consecutive ticks (feedback #75)", () => {
    vi.useFakeTimers();
    const playA = vi.fn();
    const playB = vi.fn();
    registerAmbientCandidate(playA);
    registerAmbientCandidate(playB);

    const order: (typeof playA)[] = [];
    playA.mockImplementation(() => order.push(playA));
    playB.mockImplementation(() => order.push(playB));

    // Ambient pool capacity is 2, so both slots would otherwise fill up and
    // mask a same-candidate repeat. Simulate real usage: each ambient play
    // releases its slot again shortly after (a short motion clip finishing),
    // well within one tick interval, so the pool never gets full on its own.
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(7_500);
    }

    for (let i = 1; i < order.length; i++) {
      expect(order[i]).not.toBe(order[i - 1]);
    }
    expect(playA).toHaveBeenCalled();
    expect(playB).toHaveBeenCalled();
  });
});
