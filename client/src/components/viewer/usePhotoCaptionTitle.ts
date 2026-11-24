import { useEffect, useRef } from "react";
import { fetchPhotoCaption } from "../../api";
import { logFailure } from "../../logFailure";

/**
 * AI caption: fired on every photo open, used as the tab title while this
 * photo stays open. A real generation takes
 * ~90-100s on the current Ollama host, and users flip through photos far
 * faster than that — so this must be cancelled (not just ignored) the
 * moment the photo changes or the viewer closes, or a slow response for a
 * long-since-abandoned photo could land after a later one already has its
 * own caption showing.
 */
export const usePhotoCaptionTitle = (photoPath: string | null, photoMediaType: string | null) => {
  const previousDocumentTitleRef = useRef<string | null>(null);
  useEffect(() => {
    if (!photoPath) {
      // Viewer closed: hand the tab title back to whatever owned it before
      // (usePageTitle's filter-derived title, or the static "Photrix"
      // default) rather than leaving a stale caption in the tab forever.
      if (previousDocumentTitleRef.current !== null) {
        document.title = previousDocumentTitleRef.current;
        previousDocumentTitleRef.current = null;
      }
      return;
    }

    // Capture the title as it stood *before* this photo's caption can touch
    // it, so closing (or the caption never arriving) restores exactly that —
    // usePageTitle can keep updating this in the background (filter changes)
    // without the two fighting: whichever one wrote most recently wins while
    // the viewer is open, and closing always hands control back to
    // usePageTitle rather than freezing on a stale caption title.
    if (previousDocumentTitleRef.current === null) {
      previousDocumentTitleRef.current = document.title;
    } else {
      // Flipping between photos inside an already-open viewer: don't let the
      // previous photo's caption linger in the tab title while this one's is
      // still pending.
      document.title = previousDocumentTitleRef.current;
    }

    // Captioning is photo-only (the vision model takes a single still, not a
    // video) — the server would also just return null for a video, but skip
    // the round-trip entirely rather than firing a request that can never
    // succeed.
    if (photoMediaType === "video") return;

    const abortController = new AbortController();
    fetchPhotoCaption(photoPath, abortController.signal)
      .then((caption) => {
        if (caption) document.title = caption;
      })
      .catch(logFailure("viewer.caption.failed", "Could not load the photo caption"));

    return () => abortController.abort();
  }, [photoPath, photoMediaType]);
};
