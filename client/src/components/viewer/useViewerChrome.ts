import { useEffect, type RefObject } from "react";
import type { PhotoItem } from "../../api";
import { suppressAmbientPlayback } from "../grid/tileMedia/tilePlaybackCoordinator";
import { syncDialogOpenState } from "../syncDialogOpenState";

/** What opening the viewer does to the page around it: the dialog, scrolling, the grid behind, the next photos. */
export const useViewerChrome = (
  photo: PhotoItem | null,
  items: PhotoItem[],
  dialogRef: RefObject<HTMLDialogElement | null>,
) => {
  // While the viewer is open, the grid behind it must not keep animating a
  // live photo the user isn't looking at — see feedback #80. Reuses the same
  // suppression the tile hover previews claim, so opening the viewer stops
  // any ambient clip already running and blocks new ones until it closes.
  useEffect(() => {
    if (!photo) return undefined;
    return suppressAmbientPlayback();
    // Only whether a photo is open matters here, not which one — re-running
    // per photo-to-photo navigation would needlessly flicker the suppression
    // off and back on between two photos that are both "the viewer is open".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(photo)]);

  // Prefetch adjacent images so arrow-key navigation feels instant.
  useEffect(() => {
    if (!photo) return;
    const idx = items.findIndex((item) => item.path === photo.path);
    const neighbors = [items[idx - 1], items[idx + 1]].filter(
      (item) => item?.mediaType === "photo",
    );
    const links: HTMLLinkElement[] = neighbors.map((item) => {
      const link = document.createElement("link");
      link.rel = "prefetch";
      link.as = "image";
      link.href = item.previewUrl;
      document.head.appendChild(link);
      return link;
    });
    return () => {
      links.forEach((link) => link.remove());
    };
  }, [photo, items]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    syncDialogOpenState(dialog, Boolean(photo));
  }, [photo, dialogRef]);

  useEffect(() => {
    if (!photo) return;
    document.documentElement.style.overflow = "hidden";
    document.documentElement.style.scrollbarGutter = "unset";
    return () => {
      document.documentElement.style.overflow = "";
      document.documentElement.style.scrollbarGutter = "";
    };
  }, [photo]);
};
