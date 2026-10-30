import { attachTileVideo } from "./attachTileVideo";
import { formatDuration } from "./formatDuration";

describe("formatDuration", () => {
  it("formats minutes and seconds", () => {
    expect(formatDuration(0.6)).toBe("0:01");
    expect(formatDuration(95)).toBe("1:35");
    expect(formatDuration(600)).toBe("10:00");
  });

  it("grows to hours past an hour", () => {
    expect(formatDuration(3661)).toBe("1:01:01");
  });

  it("accepts a numeric string, as metadata sometimes carries", () => {
    expect(formatDuration("42.5")).toBe("0:43");
  });

  it("returns null for anything unusable", () => {
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(0)).toBeNull();
    expect(formatDuration(-3)).toBeNull();
    expect(formatDuration("not a number")).toBeNull();
  });
});

describe("attachTileVideo", () => {
  const createVideo = () => {
    const video = document.createElement("video");
    document.body.appendChild(video);
    return video;
  };

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("starts a direct source muted and inline", () => {
    const video = createVideo();
    attachTileVideo(video, { mode: "direct", url: "http://localhost/clip.mp4" });

    expect(video.src).toBe("http://localhost/clip.mp4");
    expect(video.muted).toBe(true);
    expect(video.playsInline).toBe(true);
  });

  it("drops the source on detach so the range request is cancelled", () => {
    const video = createVideo();
    const pause = vi.spyOn(video, "pause");

    const handle = attachTileVideo(video, {
      mode: "direct",
      url: "http://localhost/clip.mp4",
    });
    handle.detach();

    expect(pause).toHaveBeenCalled();
    expect(video.hasAttribute("src")).toBe(false);
  });

  it("is safe to detach more than once", () => {
    const video = createVideo();
    const handle = attachTileVideo(video, {
      mode: "direct",
      url: "http://localhost/clip.mp4",
    });

    handle.detach();
    expect(() => handle.detach()).not.toThrow();
  });

  it("loops back to the start rather than playing past the cached region", () => {
    const video = createVideo();
    attachTileVideo(video, {
      mode: "direct",
      url: "http://localhost/clip.mp4",
      previewMaxSeconds: 3,
    });

    // jsdom won't advance playback on its own, so drive currentTime directly.
    video.currentTime = 4;
    video.dispatchEvent(new Event("timeupdate"));

    expect(video.currentTime).toBe(0);
  });

  it("does not loop a live-transcode source with no previewMaxSeconds", () => {
    const video = createVideo();
    attachTileVideo(video, { mode: "hls", url: "http://localhost/clip.m3u8" });

    video.currentTime = 400;
    video.dispatchEvent(new Event("timeupdate"));

    expect(video.currentTime).toBe(400);
  });

  it("stops honouring timeupdate once detached", () => {
    const video = createVideo();
    const handle = attachTileVideo(video, {
      mode: "direct",
      url: "http://localhost/clip.mp4",
      previewMaxSeconds: 3,
    });
    handle.detach();

    video.currentTime = 4;
    video.dispatchEvent(new Event("timeupdate"));

    expect(video.currentTime).toBe(4);
  });
});
