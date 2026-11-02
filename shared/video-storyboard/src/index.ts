/**
 * The layout of a video's storyboard sprite, shared by the server (which
 * builds it) and the client (which picks frames out of it). See README.md.
 */

/** Frames are never closer together than this. */
export const STORYBOARD_MIN_INTERVAL_SECONDS = 2;
/** However long the video, at most this many frames. */
export const STORYBOARD_MAX_FRAMES = 100;
/** Frames per row of the sprite. */
export const STORYBOARD_COLUMNS = 10;
/** The long edge of one frame, in pixels. */
export const STORYBOARD_FRAME_LONG_EDGE = 240;

export type StoryboardPlan = {
  frames: number;
  columns: number;
  rows: number;
  intervalSeconds: number;
};

/** The plan for a video of this length, or null when the length is unknown. */
export const planStoryboard = (durationSeconds: number | null | undefined): StoryboardPlan | null => {
  if (!durationSeconds || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  const intervalSeconds = Math.max(
    STORYBOARD_MIN_INTERVAL_SECONDS,
    durationSeconds / STORYBOARD_MAX_FRAMES,
  );
  const frames = Math.min(
    STORYBOARD_MAX_FRAMES,
    Math.max(1, Math.ceil(durationSeconds / intervalSeconds)),
  );
  const columns = Math.min(STORYBOARD_COLUMNS, frames);
  return { frames, columns, rows: Math.ceil(frames / columns), intervalSeconds };
};

/** When frame `index` is taken: the middle of its slot, kept inside the video. */
export const storyboardFrameTime = (
  plan: StoryboardPlan,
  index: number,
  durationSeconds: number,
): number => Math.max(0, Math.min((index + 0.5) * plan.intervalSeconds, durationSeconds - 0.1));

/** The frame that shows the moment `seconds` into the video. */
export const storyboardFrameAt = (plan: StoryboardPlan, seconds: number): number =>
  Math.min(plan.frames - 1, Math.max(0, Math.floor(seconds / plan.intervalSeconds)));
