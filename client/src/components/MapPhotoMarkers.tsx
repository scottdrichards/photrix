import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Overlay from "ol/Overlay";
import type Map from "ol/Map";
import { acquireThumbnailSlot } from "./MapFilter.thumbnailQueue";
import css from "./MapFilter.module.css";

export type MapRepresentative = {
  /** Stable across pans: derived from the pin's rounded coordinates. */
  key: string;
  /** Position in the map's own projection. */
  coordinate: number[];
  /** Small thumbnail URL, or undefined when the pin has no sample file. */
  thumbnailUrl?: string;
  label: string;
  /** Age-ramp color of the pin this photo stands for. */
  color: string;
};

/**
 * Loads `url` through the shared concurrency gate and hands back the src to
 * render. Unmounting (a pin that panned out of view) releases the slot and
 * clears the src, which aborts an in-flight request rather than paying for a
 * picture nobody will see.
 */
const useQueuedThumbnail = (url: string | undefined) => {
  const [src, setSrc] = useState<string | undefined>(undefined);
  const releaseRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setSrc(undefined);
    if (!url) {
      return;
    }
    let cancelled = false;
    const release = acquireThumbnailSlot(() => {
      if (!cancelled) setSrc(url);
    });
    releaseRef.current = release;
    return () => {
      cancelled = true;
      release();
      releaseRef.current = null;
    };
  }, [url]);

  const settle = useCallback(() => {
    releaseRef.current?.();
    releaseRef.current = null;
  }, []);

  return { src, onLoad: settle, onError: settle };
};

const MapPhotoMarker = ({
  item,
  onSelect,
}: {
  item: MapRepresentative;
  onSelect: (item: MapRepresentative) => void;
}) => {
  const { src, onLoad, onError } = useQueuedThumbnail(item.thumbnailUrl);
  const [failed, setFailed] = useState(false);

  return (
    <button
      type="button"
      className={css.photoMarker}
      style={{ borderColor: item.color }}
      title={item.label}
      aria-label={`Zoom to ${item.label}`}
      onClick={() => onSelect(item)}
    >
      {src && !failed ? (
        <img
          className={css.photoMarkerImage}
          src={src}
          alt=""
          decoding="async"
          onLoad={onLoad}
          onError={() => {
            setFailed(true);
            onError();
          }}
        />
      ) : (
        <span className={css.photoMarkerPlaceholder} aria-hidden="true" />
      )}
    </button>
  );
};

/**
 * Pins one OpenLayers overlay per representative and renders the thumbnail into
 * it through a portal, so OpenLayers keeps the positioning while React keeps the
 * content. Overlays are reused by key across pans; only the ones that left the
 * selection are torn down.
 */
export const MapPhotoMarkers = ({
  map,
  items,
  onSelect,
}: {
  map: Map | null;
  items: MapRepresentative[];
  onSelect: (item: MapRepresentative) => void;
}) => {
  // `Map` is the OpenLayers import in this module, so the built-in needs qualifying.
  const registryRef = useRef(
    new globalThis.Map<string, { overlay: Overlay; element: HTMLDivElement }>(),
  );
  const [hosts, setHosts] = useState<Array<{ key: string; element: HTMLDivElement }>>([]);

  useEffect(() => {
    const registry = registryRef.current;
    if (!map) {
      registry.clear();
      setHosts([]);
      return;
    }

    const liveKeys = new Set(items.map((item) => item.key));
    for (const [key, entry] of registry) {
      if (!liveKeys.has(key)) {
        map.removeOverlay(entry.overlay);
        registry.delete(key);
      }
    }

    for (const item of items) {
      let entry = registry.get(item.key);
      if (!entry) {
        const element = document.createElement("div");
        element.className = css.photoMarkerHost ?? "";
        const overlay = new Overlay({
          element,
          positioning: "bottom-center",
          offset: [0, -12],
          stopEvent: false,
        });
        map.addOverlay(overlay);
        entry = { overlay, element };
        registry.set(item.key, entry);
      }
      entry.overlay.setPosition(item.coordinate);
    }

    setHosts(
      items.flatMap((item) => {
        const entry = registry.get(item.key);
        return entry ? [{ key: item.key, element: entry.element }] : [];
      }),
    );
  }, [map, items]);

  useEffect(
    () => () => {
      const registry = registryRef.current;
      for (const [, entry] of registry) {
        map?.removeOverlay(entry.overlay);
      }
      registry.clear();
    },
    [map],
  );

  const byKey = new globalThis.Map(items.map((item) => [item.key, item]));

  return (
    <>
      {hosts.map(({ key, element }) => {
        const item = byKey.get(key);
        return item
          ? createPortal(<MapPhotoMarker item={item} onSelect={onSelect} />, element, key)
          : null;
      })}
    </>
  );
};
