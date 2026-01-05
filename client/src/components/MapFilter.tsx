import {
  Button,
  Caption1,
  Spinner,
  Switch,
  Tooltip
} from "@fluentui/react-components";
import Feature from "ol/Feature";
import Map from "ol/Map";
import View from "ol/View";
import { boundingExtent } from "ol/extent";
import Point from "ol/geom/Point";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import "ol/ol.css";
import { fromLonLat, transformExtent } from "ol/proj";
import OSM from "ol/source/OSM";
import VectorSource from "ol/source/Vector";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchGeotaggedPhotos } from "../api";
import type { GeoBounds, GeoPoint } from "../api";
import { markerStyle, useMapFilterStyles } from "./MapFilter.styles";

type MapFilterProps = {
  bounds?: GeoBounds;
  onBoundsChange: (bounds: GeoBounds | undefined) => void;
  includeSubfolders: boolean;
  path: string;
  ratingFilter: { rating: number; atLeast: boolean } | null;
  mediaTypeFilter: "all" | "photo" | "video" | "other";
};

const boundsEqual = (a: GeoBounds | null, b: GeoBounds | null) => {
  if (!a || !b) {
    return false;
  }
  const epsilon = 1e-4;
  return (
    Math.abs(a.north - b.north) < epsilon &&
    Math.abs(a.south - b.south) < epsilon &&
    Math.abs(a.east - b.east) < epsilon &&
    Math.abs(a.west - b.west) < epsilon
  );
};

export const MapFilter = ({
  bounds,
  onBoundsChange,
  includeSubfolders,
  path,
  ratingFilter,
  mediaTypeFilter,
}: MapFilterProps) => {
  const styles = useMapFilterStyles();
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const vectorSourceRef = useRef(new VectorSource());
  const lastBoundsRef = useRef<GeoBounds | null>(null);
  const hasFittedRef = useRef(false);
  const activeRef = useRef(Boolean(bounds));
  const userInteractedRef = useRef(false);
  const [points, setPoints] = useState<GeoPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalPins, setTotalPins] = useState(0);
  const [truncated, setTruncated] = useState(false);

  const clusterSize = useMemo(() => {
    if (!bounds) {
      return undefined;
    }
    const latSpan = Math.max(Math.abs(bounds.north - bounds.south), 1e-9);
    const lonSpan = Math.max(Math.abs(bounds.east - bounds.west), 1e-9);
    const targetCells = 400_000;
    const cellSize = Math.max(latSpan, lonSpan) / Math.sqrt(targetCells);
    return Math.max(cellSize, 0.00000001);
  }, [bounds]);

  useEffect(() => {
    const controller = new AbortController();

    const loadPoints = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchGeotaggedPhotos({
          includeSubfolders,
          path,
          ratingFilter,
          mediaTypeFilter,
          locationBounds: bounds,
          clusterSize,
          signal: controller.signal,
        });
        setPoints(result.points);
        setTotalPins(result.total);
        setTruncated(result.truncated);
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return;
        }
        console.error(err);
        setError((err as Error).message ?? "Failed to load map data");
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    loadPoints();

    return () => controller.abort();
  }, [includeSubfolders, path, ratingFilter, mediaTypeFilter, bounds, clusterSize]);

  const pinSummary = useMemo(() => {
    const displayed = points.length;
    if (typeof totalPins === "number") {
      return truncated ? `${displayed} of ${totalPins} pins (limited)` : `${displayed} of ${totalPins} pins`;
    }
    return `${displayed} pins`;
  }, [points.length, totalPins, truncated]);

  const showOverlay = loading && vectorSourceRef.current.getFeatures().length === 0;

  activeRef.current = Boolean(bounds);

  useEffect(() => {
    if (mapRef.current || !mapElementRef.current) {
      return;
    }

    const baseLayer = new TileLayer({ source: new OSM() });
    const pinLayer = new VectorLayer({ source: vectorSourceRef.current, style: markerStyle });

    const map = new Map({
      target: mapElementRef.current,
      layers: [baseLayer, pinLayer],
      view: new View({
        center: fromLonLat([0, 30]),
        zoom: 2,
        minZoom: 0,
        maxZoom: 22,
      }),
    });

    requestAnimationFrame(() => {
      map.updateSize();
    });

    const resizeObserver = new ResizeObserver(() => {
      map.updateSize();
    });
    resizeObserver.observe(mapElementRef.current);

    const notifyBounds = () => {
      if (!userInteractedRef.current) {
        return;
      }
      const size = map.getSize();
      if (!size) {
        return;
      }
      const extent = map.getView().calculateExtent(size);
      const [west, south, east, north] = transformExtent(extent, "EPSG:3857", "EPSG:4326");
      const nextBounds: GeoBounds = { west, east, north, south };

      if (!boundsEqual(lastBoundsRef.current, nextBounds)) {
        lastBoundsRef.current = nextBounds;
        onBoundsChange(nextBounds);
        userInteractedRef.current = false;
      }
    };

    const markUserInteraction = () => {
      userInteractedRef.current = true;
    };

    const viewport = map.getViewport();
    const handleWheel = () => markUserInteraction();
    viewport.addEventListener("wheel", handleWheel, { passive: true });

    map.on("pointerdrag", markUserInteraction);
    map.on("dblclick", markUserInteraction);
    map.on("singleclick", markUserInteraction);
    map.on("moveend", notifyBounds);
    mapRef.current = map;

    return () => {
      resizeObserver.disconnect();
      viewport.removeEventListener("wheel", handleWheel);
      map.un("pointerdrag", markUserInteraction);
      map.un("dblclick", markUserInteraction);
      map.un("singleclick", markUserInteraction);
      map.setTarget(undefined);
      mapRef.current = null;
    };
  }, [onBoundsChange]);

  useEffect(() => {
    activeRef.current = Boolean(bounds);
    if (!bounds) {
      lastBoundsRef.current = null;
      userInteractedRef.current = false;
    }
  }, [bounds]);

  useEffect(() => {
    if (!mapRef.current) {
      return;
    }

    vectorSourceRef.current.clear();
    const features = points.map((point) => {
      const feature = new Feature({
        geometry: new Point(fromLonLat([point.longitude, point.latitude])),
      });
      return feature;
    });

    vectorSourceRef.current.addFeatures(features);

    if (!points.length) {
      hasFittedRef.current = false;
      return;
    }

    if (!hasFittedRef.current) {
      const extent = boundingExtent(features.map((feature) => (feature.getGeometry() as Point).getCoordinates()));
      mapRef.current.getView().fit(extent, { padding: [24, 24, 24, 24], maxZoom: 20, duration: 200 });
      hasFittedRef.current = true;
    }
  }, [points]);

  useEffect(() => {
    if (!mapRef.current || !activeRef.current) {
      return;
    }

    const size = mapRef.current.getSize();
    if (!size) {
      return;
    }

    const extent = mapRef.current.getView().calculateExtent(size);
    const [west, south, east, north] = transformExtent(extent, "EPSG:3857", "EPSG:4326");
      const nextBounds: GeoBounds = { west, east, north, south };
    if (!boundsEqual(lastBoundsRef.current, nextBounds)) {
      lastBoundsRef.current = nextBounds;
      onBoundsChange(nextBounds);
    }
  }, [onBoundsChange]);

  const fitToData = () => {
    if (!mapRef.current) {
      return;
    }

    userInteractedRef.current = true;

    if (!points.length) {
      mapRef.current.getView().setCenter(fromLonLat([0, 0]));
      mapRef.current.getView().setZoom(1.5);
      return;
    }

    const extent = vectorSourceRef.current.getExtent();
    mapRef.current.getView().fit(extent, { padding: [24, 24, 24, 24], maxZoom: 20, duration: 200 });
  };

  return (
    <div className={styles.card}>
      <div className={styles.headerRow}>
        <div>
          <Caption1>Map filter</Caption1>
          <Caption1 className={styles.description}>Pins show items with location metadata.</Caption1>
        </div>
        <div className={styles.actions}>
          <Tooltip content="Keep results synced to the current map view" relationship="label">
            <Switch
              checked={Boolean(bounds)}
              onChange={(_, data) => {
                if (!mapRef.current) {
                  return;
                }
                if (!data.checked) {
                  onBoundsChange(undefined);
                  return;
                }
                const size = mapRef.current.getSize();
                if (!size) {
                  return;
                }
                const extent = mapRef.current.getView().calculateExtent(size);
                const [west, south, east, north] = transformExtent(extent, "EPSG:3857", "EPSG:4326");
                const nextBounds:GeoBounds = { west, east, north, south };
                lastBoundsRef.current = nextBounds;
                onBoundsChange(nextBounds);
              }}
              label="Filter to map view"
            />
          </Tooltip>
          <Button size="small" appearance="secondary" onClick={fitToData} disabled={!points.length}>
            Fit to pins
          </Button>
        </div>
      </div>

      <div className={styles.mapShell}>
        <div ref={mapElementRef} className={styles.map} />
        {showOverlay ? (
          <div className={styles.overlay}>
            <Spinner label="Loading map data" />
          </div>
        ) : null}
      </div>

      <div className={styles.statusRow}>
        <Caption1>{pinSummary}</Caption1>
        {error ? <Caption1 className={styles.error}>{error}</Caption1> : null}
        {truncated ? <Caption1 className={styles.description}>Limited to current slice for performance.</Caption1> : null}
      </div>
    </div>
  );
};
