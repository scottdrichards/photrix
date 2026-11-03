import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { VideoScrubPreview } from "./VideoScrubPreview";

// jsdom never loads images; this one "loads" as soon as it is given a source.
class InstantImage {
  onload: (() => void) | null = null;
  set src(_value: string) {
    queueMicrotask(() => this.onload?.());
  }
}

const seekTo = (video: HTMLVideoElement, seconds: number) => {
  Object.defineProperty(video, "currentTime", { value: seconds, configurable: true });
  video.dispatchEvent(new Event("seeking"));
};

const setup = async (durationSeconds: number | null = 35) => {
  const videoRef = createRef<HTMLVideoElement>();
  const utils = render(
    <div>
      <video ref={videoRef}>
        <track kind="captions" />
      </video>
      <VideoScrubPreview
        videoRef={videoRef}
        path="/2024/clip.mp4"
        durationSeconds={durationSeconds}
        aspectRatio={16 / 9}
      />
    </div>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return { ...utils, video: videoRef.current! };
};

describe("VideoScrubPreview", () => {
  beforeEach(() => {
    vi.stubGlobal("Image", InstantImage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the storyboard frame for the moment being dragged to, until the real one lands", async () => {
    const { video } = await setup();
    expect(screen.queryByTestId("video-scrub-preview")).toBeNull();
    act(() => {
      video.dispatchEvent(new Event("playing"));
    });

    act(() => seekTo(video, 12.5));
    const preview = screen.getByTestId("video-scrub-preview");
    // 35 s → a frame every 2 s, ten to a row: 12.5 s is frame 6, top row.
    const frame = preview.querySelector<HTMLElement>("[data-frame]")!;
    expect(frame.dataset.frame).toBe("6");
    expect(frame.style.backgroundImage).toContain("representation=storyboard");
    expect(frame.style.backgroundSize).toBe("1000% 200%");
    expect(frame.style.backgroundPosition).toBe(`${(6 / 9) * 100}% 0%`);
    expect(preview.textContent).toContain("0:12");

    act(() => seekTo(video, 30));
    expect(screen.getByTestId("video-scrub-preview").querySelector<HTMLElement>("[data-frame]")!
      .dataset.frame).toBe("15");

    act(() => {
      video.dispatchEvent(new Event("seeked"));
    });
    expect(screen.queryByTestId("video-scrub-preview")).toBeNull();
  });

  it("ignores the seeks the player makes for itself while the video loads (feedback #174)", async () => {
    const { video } = await setup();
    // hls.js snapping onto the first buffered frame, before anything played.
    act(() => seekTo(video, 0.033));
    expect(screen.queryByTestId("video-scrub-preview")).toBeNull();

    act(() => {
      video.dispatchEvent(new Event("playing"));
    });
    act(() => seekTo(video, 20));
    expect(screen.getByTestId("video-scrub-preview")).toBeInTheDocument();

    // A new source starts over: hidden, and waiting to be played again.
    act(() => {
      video.dispatchEvent(new Event("emptied"));
    });
    expect(screen.queryByTestId("video-scrub-preview")).toBeNull();
    act(() => seekTo(video, 1));
    expect(screen.queryByTestId("video-scrub-preview")).toBeNull();
  });

  it("answers a drag on a video that has not played yet", async () => {
    const { video } = await setup();
    act(() => {
      video.dispatchEvent(new Event("pointerdown"));
    });
    act(() => seekTo(video, 12.5));
    expect(screen.getByTestId("video-scrub-preview")).toBeInTheDocument();
  });

  it("shows nothing for a video of unknown length", async () => {
    const { video } = await setup(null);
    act(() => {
      video.dispatchEvent(new Event("playing"));
    });
    act(() => seekTo(video, 5));
    expect(screen.queryByTestId("video-scrub-preview")).toBeNull();
  });

  it("shows nothing until the storyboard has loaded", async () => {
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        src = "";
      },
    );
    const { video } = await setup();
    act(() => {
      video.dispatchEvent(new Event("playing"));
    });
    act(() => seekTo(video, 5));
    expect(screen.queryByTestId("video-scrub-preview")).toBeNull();
  });
});
