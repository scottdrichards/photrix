import { isAbort, logFailure } from "../logFailure";

/**
 * Starts playback. Two rejections are expected and ignored: NotAllowedError
 * (the browser's autoplay policy said no) and AbortError (a pause or source
 * change interrupted it). Anything else is reported.
 */
export const playVideo = (video: HTMLVideoElement): void => {
  // Promise.resolve: jsdom's play() returns undefined rather than a promise.
  void Promise.resolve(video.play()).catch((error: unknown) => {
    if (isAbort(error) || (error instanceof Error && error.name === "NotAllowedError")) return;
    logFailure("video.play.failed", "Video playback failed to start")(error);
  });
};
