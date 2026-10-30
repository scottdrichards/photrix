import {
  __resetHoverIntentForTests,
  isHoverSuppressedByScroll,
} from "./ThumbnailTile.hoverIntent";

const scroll = () => window.dispatchEvent(new Event("scroll"));

const movePointer = (clientX: number, clientY: number) => {
  const event = new Event("pointermove") as Event & {
    clientX: number;
    clientY: number;
  };
  Object.assign(event, { clientX, clientY });
  window.dispatchEvent(event);
};

describe("hover intent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetHoverIntentForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not suppress hover when nothing is happening", () => {
    expect(isHoverSuppressedByScroll()).toBe(false);
  });

  it("suppresses hover immediately after a scroll", () => {
    scroll();
    expect(isHoverSuppressedByScroll()).toBe(true);
  });

  it("stops suppressing once the scroll goes quiet", () => {
    scroll();
    vi.advanceTimersByTime(500);
    expect(isHoverSuppressedByScroll()).toBe(false);
  });

  it("lets a real pointer move cancel the suppression at once", () => {
    movePointer(10, 10);
    scroll();
    expect(isHoverSuppressedByScroll()).toBe(true);

    movePointer(11, 12);

    expect(isHoverSuppressedByScroll()).toBe(false);
  });

  it("ignores the pointer event a scroll dispatches to refresh hover state", () => {
    movePointer(10, 10);
    scroll();

    // Browsers re-dispatch pointer state at the position the cursor already had
    // so hover can be recomputed after the page moved. That is not the user
    // pointing at anything, and it must not re-open the hover path.
    movePointer(10, 10);

    expect(isHoverSuppressedByScroll()).toBe(true);
  });
});
