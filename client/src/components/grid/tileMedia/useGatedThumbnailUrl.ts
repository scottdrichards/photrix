import { useEffect, useRef, useState } from "react";
import { acquireSharpThumbnailSlot } from "./sharpThumbnailQueue";

/**
 * Admits `url` through the shared sharp-thumbnail queue (see
 * sharpThumbnailQueue.ts) before it is used as an <img src> — the request
 * (and the decode it triggers once bytes arrive) doesn't start until a slot
 * is granted. Returns the admitted URL (undefined until then) plus a
 * `release` to call once the image settles, so its slot is freed promptly
 * rather than held for the tile's whole lifetime.
 *
 * A tile whose target `url` changes (reused for a different photo) or goes
 * away (unmounts) before its turn revokes the still-queued request instead
 * of spending a slot on it.
 */
export const useGatedThumbnailUrl = (
  url: string | undefined,
): { admittedUrl: string | undefined; release: () => void } => {
  const [admittedUrl, setAdmittedUrl] = useState<string | undefined>(undefined);
  const releaseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // A previous url's slot (active or still queued) is no longer relevant.
    releaseRef.current?.();
    releaseRef.current = null;
    setAdmittedUrl(undefined);

    if (!url) return;

    let cancelled = false;
    const release = acquireSharpThumbnailSlot(() => {
      if (!cancelled) setAdmittedUrl(url);
    });
    releaseRef.current = release;

    return () => {
      cancelled = true;
      release();
      releaseRef.current = null;
    };
  }, [url]);

  const release = () => {
    releaseRef.current?.();
    releaseRef.current = null;
  };

  return { admittedUrl, release };
};
