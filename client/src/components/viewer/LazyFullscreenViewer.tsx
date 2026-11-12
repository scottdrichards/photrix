import { Suspense, useState } from "react";
import { lazyPart } from "../../lazyPart";
import { useSelectionContext } from "../selection/SelectionContext";

const viewer = lazyPart("viewer", () =>
  import("./FullscreenViewer").then((module) => module.FullscreenViewer),
);

/** Fetches the viewer ahead of the first photo being opened. */
export const preloadFullscreenViewer = viewer.preload;

/**
 * The fullscreen viewer, loaded apart from the page: with the video player it
 * is the largest part of the app, and the grid doesn't need it.
 *
 * It mounts when the first photo is opened and stays mounted from then on, as
 * it always was, because it keeps state between photos.
 */
export const LazyFullscreenViewer = () => {
  const { selected } = useSelectionContext();
  const [opened, setOpened] = useState(false);
  if (selected && !opened) setOpened(true);
  if (!opened) return null;
  return (
    <Suspense fallback={null}>
      <viewer.Part />
    </Suspense>
  );
};
