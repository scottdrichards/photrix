import { useCallback, useEffect, useMemo, useState } from "react";
import { cx } from "../cx";
import { Spinner } from "../Spinner";
import css from "./MapFilter.module.css";
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
import { fetchGeotaggedPhotos } from "../api";
import type { GeoPoint } from "../api";
import type { GeoBoundsLike as GeoBounds } from "../../../shared/filter-contract/src";
import { markerStyle } from "./MapFilter.styles";
import { useFilterContext } from "./filter/FilterContext";

type MapFilterProps = {
  compact?: boolean;
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

const maybeBoundsEqual = (
  a: GeoBounds | null | undefined,
  b: GeoBounds | null | undefined,
) => {
  if (!a && !b) {
    return true;
  }
  return boundsEqual(a ?? null, b ?? null);
};

export const MapFilter: React.FC<MapFilterProps> = ({ compact = false }) => {
  const { filter, setFilter } = useFilterContext();
  const { locationBounds } = filter;
  const normalizedLocationBounds = locationBounds ?? undefined;

  const [mapElement, setMapElement] = useState<HTMLDivElement | null>(null);
  const [mapInstance, setMapInstance] = useState<Map | null>(null);
  const [vectorSource, setVectorSource] = useState<VectorSource | null>(null);
  const [pendingLocationBounds, setPendingLocationBounds] = useState<
    GeoBounds | undefined
  >(normalizedLocationBounds);
  const [hasFitted, setHasFitted] = useState(false);
  const [points, setPoints] = useState<GeoPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalPins, setTotalPins] = useState(0);
  const [truncated, setTruncated] = useState(false);

  const mapElementRef = useCallback((element: HTMLDivElement | null) => {
    setMapElement(element);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    const loadPoints = async () => {
      setLoading(true);
      setError(null);
      try {
        let clusterSize = undefined;
        if (normalizedLocationBounds) {
          const latSpan = Math.max(
            Math.abs(normalizedLocationBounds.north - normalizedLocationBounds.south),
            1e-9,
          );
          const lonSpan = Math.max(
            Math.abs(normalizedLocationBounds.east - normalizedLocationBounds.west),
            1e-9,
          );
          const targetCells = 400_000;
          const cellSize = Math.max(latSpan, lonSpan) / Math.sqrt(targetCells);
          clusterSize = Math.max(cellSize, 0.00000001);
        }
        const result = await fetchGeotaggedPhotos({
          ...filter,
          locationBounds: normalizedLocationBounds,
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
  }, [filter, normalizedLocationBounds]);

  const pinSummary = useMemo(() => {
    const displayed = points.length;
    if (typeof totalPins === "number") {
      return truncated
        ? `${displayed} of ${totalPins} pins (limited)`
        : `${displayed} of ${totalPins} pins`;
    }
    return `${displayed} pins`;
  }, [points.length, totalPins, truncated]);

  const showOverlay = loading && (vectorSource?.getFeatures().length ?? 0) === 0;

  useEffect(() => {
    if (maybeBoundsEqual(pendingLocationBounds, normalizedLocationBounds)) {
      return;
    }

    setFilter({ locationBounds: pendingLocationBounds });
  }, [normalizedLocationBounds, pendingLocationBounds, setFilter]);

  useEffect(() => {
    setPendingLocationBounds(normalizedLocationBounds);
  }, [normalizedLocationBounds]);

  useEffect(() => {
    if (!mapElement) {
      return;
    }

    const source = new VectorSource();
    const baseLayer = new TileLayer({ source: new OSM() });
    const pinLayer = new VectorLayer({ source, style: markerStyle });

    const map = new Map({
      target: mapElement,
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
      if (normalizedLocationBounds) {
        const extent = transformExtent(
          [
            normalizedLocationBounds.west,
            normalizedLocationBounds.south,
            normalizedLocationBounds.east,
            normalizedLocationBounds.north,
          ],
          "EPSG:4326",
          "EPSG:3857",
        );
        map.getView().fit(extent, { padding: [24, 24, 24, 24], maxZoom: 20 });
        setHasFitted(true);
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      map.updateSize();
    });
    resizeObserver.observe(mapElement);

    const notifyBounds = () => {
      const size = map.getSize();
      if (!size) {
        return;
      }
      const extent = map.getView().calculateExtent(size);
      const [west, south, east, north] = transformExtent(
        extent,
        "EPSG:3857",
        "EPSG:4326",
      );
      const nextBounds: GeoBounds = { west, east, north, south };

      if (!map.get("userInteracted")) {
        return;
      }

      const previousBounds = (map.get("lastBounds") as GeoBounds | null) ?? null;
      if (boundsEqual(previousBounds, nextBounds)) {
        map.set("userInteracted", false);
        return;
      }

      map.set("lastBounds", nextBounds);
      setPendingLocationBounds(nextBounds);
      map.set("userInteracted", false);
    };

    const markUserInteraction = () => {
      map.set("userInteracted", true);
    };

    const viewport = map.getViewport();
    const handleWheel = () => markUserInteraction();
    viewport.addEventListener("wheel", handleWheel, { passive: true });

    map.on("pointerdrag", markUserInteraction);
    map.on("dblclick", markUserInteraction);
    map.on("singleclick", markUserInteraction);
    map.on("moveend", notifyBounds);
    setMapInstance(map);
    setVectorSource(source);

    return () => {
      resizeObserver.disconnect();
      viewport.removeEventListener("wheel", handleWheel);
      map.un("pointerdrag", markUserInteraction);
      map.un("dblclick", markUserInteraction);
      map.un("singleclick", markUserInteraction);
      map.un("moveend", notifyBounds);
      map.setTarget(undefined);
      setMapInstance(null);
      setVectorSource(null);
    };
  }, [mapElement]);

  useEffect(() => {
    if (!locationBounds) {
      mapInstance?.set("userInteracted", false);
      mapInstance?.set("lastBounds", null);
    }
  }, [locationBounds, mapInstance]);

  useEffect(() => {
    if (!mapInstance || !vectorSource) {
      return;
    }

    vectorSource.clear();
    const features = points.map((point) => {
      const feature = new Feature({
        geometry: new Point(fromLonLat([point.longitude, point.latitude])),
      });
      return feature;
    });

    vectorSource.addFeatures(features);

    if (!points.length) {
      setHasFitted(false);
      return;
    }

    if (!hasFitted) {
      const extent = boundingExtent(
        features.map((feature) => (feature.getGeometry() as Point).getCoordinates()),
      );
      mapInstance
        .getView()
        .fit(extent, { padding: [24, 24, 24, 24], maxZoom: 20, duration: 200 });
      setHasFitted(true);
    }
  }, [hasFitted, mapInstance, points, vectorSource]);

  const clearMapFilter = () => {
    setPendingLocationBounds(undefined);
    setHasFitted(false);
  };

  return (
    <div className={cx(css.card, compact ? css.compactCard : undefined)}>
      <div className={css.headerRow}>
        <div>
          <small>Map filter</small>
          <small className={css.description}>
            Pins show items with location metadata.
          </small>
        </div>
        <div className={css.actions}>
          {locationBounds ? (
            <button className="btn btn-sm" onClick={clearMapFilter}>
              Clear map filter
            </button>
          ) : null}
        </div>
      </div>

      <div className={css.mapShell}>
        <div
          ref={mapElementRef}
          className={cx(css.map, compact ? css.compactMap : undefined)}
        />
        {showOverlay ? (
          <div className={css.overlay}>
            <Spinner label="Loading map data" />
          </div>
        ) : null}
      </div>

      <div className={css.statusRow}>
        <small>{pinSummary}</small>
        {error ? <small className={css.error}>{error}</small> : null}
        {truncated ? (
          <small className={css.description}>
            Limited to current slice for performance.
          </small>
        ) : null}
      </div>
    </div>
  );
};
