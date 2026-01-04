import {
  Button,
  Caption1,
  Spinner,
  Switch,
  Tooltip,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { useEffect, useMemo, useRef } from "react";
import Map from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import { fromLonLat, transformExtent } from "ol/proj";
import OSM from "ol/source/OSM";
import VectorSource from "ol/source/Vector";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import { boundingExtent } from "ol/extent";
import { Circle as CircleStyle, Fill, Stroke, Style } from "ol/style";
import type { GeoBounds, GeoPoint } from "../api";
import "ol/ol.css";

type MapFilterProps = {
  points: GeoPoint[];
  bounds?: GeoBounds;
  onBoundsChange: (bounds: GeoBounds | undefined) => void;
  loading?: boolean;
  error?: string | null;
  totalPins?: number;
  truncated?: boolean;
};

const useStyles = makeStyles({
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalM,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingHorizontalS,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  headerRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
    flexWrap: "wrap",
  },
  description: {
    color: tokens.colorNeutralForeground3,
  },
  actions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
    flexWrap: "wrap",
  },
  mapShell: {
    position: "relative",
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  map: {
    width: "100%",
    height: "340px",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `${tokens.colorNeutralBackground1}CC`,
  },
  statusRow: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
    flexWrap: "wrap",
    color: tokens.colorNeutralForeground3,
  },
  error: {
    color: tokens.colorPaletteRedForeground3,
  },
});

const markerStyle = new Style({
  image: new CircleStyle({
    radius: 5,
    fill: new Fill({ color: "#2b6cb0" }),
    stroke: new Stroke({ color: "#f3f6fb", width: 1.25 }),
  }),
});

const clampLat = (value: number) => Math.min(Math.max(value, -90), 90);
const clampLon = (value: number) => Math.min(Math.max(value, -180), 180);

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
  points,
  bounds,
  onBoundsChange,
  loading = false,
  error,
  totalPins,
  truncated,
}: MapFilterProps) => {
  const styles = useStyles();
  const mapElementRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const vectorSourceRef = useRef(new VectorSource());
  const lastBoundsRef = useRef<GeoBounds | null>(null);
  const hasFittedRef = useRef(false);
  const activeRef = useRef(Boolean(bounds));
  const userInteractedRef = useRef(false);

  const pinSummary = useMemo(() => {
    const displayed = points.length;
    if (typeof totalPins === "number") {
      return truncated ? `${displayed} of ${totalPins} pins (limited)` : `${displayed} of ${totalPins} pins`;
    }
    return `${displayed} pins`;
  }, [points.length, totalPins, truncated]);

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
        minZoom: 1,
        maxZoom: 18,
      }),
    });

    const notifyBounds = () => {
      if (!activeRef.current && !userInteractedRef.current) {
        return;
      }
      const size = map.getSize();
      if (!size) {
        return;
      }
      const extent = map.getView().calculateExtent(size);
      const [west, south, east, north] = transformExtent(extent, "EPSG:3857", "EPSG:4326");
      const nextBounds = {
        west: clampLon(west),
        east: clampLon(east),
        north: clampLat(north),
        south: clampLat(south),
      } satisfies GeoBounds;

      if (!boundsEqual(lastBoundsRef.current, nextBounds)) {
        lastBoundsRef.current = nextBounds;
        onBoundsChange(nextBounds);
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
      viewport.removeEventListener("wheel", handleWheel);
      map.un("pointerdrag", markUserInteraction);
      map.un("dblclick", markUserInteraction);
      map.un("singleclick", markUserInteraction);
      map.setTarget(undefined);
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
      mapRef.current.getView().fit(extent, { padding: [24, 24, 24, 24], maxZoom: 12, duration: 200 });
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
    const nextBounds = {
      west: clampLon(west),
      east: clampLon(east),
      north: clampLat(north),
      south: clampLat(south),
    } satisfies GeoBounds;
    if (!boundsEqual(lastBoundsRef.current, nextBounds)) {
      lastBoundsRef.current = nextBounds;
      onBoundsChange(nextBounds);
    }
  }, [onBoundsChange]);

  const fitToData = () => {
    if (!mapRef.current) {
      return;
    }

    if (!points.length) {
      mapRef.current.getView().setCenter(fromLonLat([0, 0]));
      mapRef.current.getView().setZoom(1.5);
      return;
    }

    const extent = vectorSourceRef.current.getExtent();
    mapRef.current.getView().fit(extent, { padding: [24, 24, 24, 24], maxZoom: 12, duration: 200 });
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
                const nextBounds = {
                  west: clampLon(west),
                  east: clampLon(east),
                  north: clampLat(north),
                  south: clampLat(south),
                } satisfies GeoBounds;
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
        {loading ? (
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
