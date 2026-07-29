import { useCallback, useEffect, useMemo, useState } from "react";
import { cx } from "../cx";
import { Spinner } from "../Spinner";
import css from "./MapFilter.module.css";
import Feature from "ol/Feature";
import Map from "ol/Map";
import View from "ol/View";
import { boundingExtent } from "ol/extent";
import LineString from "ol/geom/LineString";
import Point from "ol/geom/Point";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import "ol/ol.css";
import { fromLonLat, transformExtent } from "ol/proj";
import OSM from "ol/source/OSM";
import VectorSource from "ol/source/Vector";
import { buildGeoPointThumbnailUrl, fetchGeotaggedPhotos } from "../api";
import type { GeoPoint } from "../api";
import type { GeoBoundsLike as GeoBounds } from "../../../shared/filter-contract/src";
import { markerStyleFor, movementPathStyle } from "./MapFilter.styles";
import {
  buildAgeLegend,
  buildAgeScale,
  colorForDate,
  formatAgeRangeLabel,
  pointDate,
} from "./MapFilter.age";
import { selectRepresentatives } from "./MapFilter.representatives";
import { MapPhotoMarkers, type MapRepresentative } from "./MapPhotoMarkers";
import { useFilter } from "./filter/FilterContext";

type MapFilterProps = {
  compact?: boolean;
};

/** Pin identity that survives a pan, so an unchanged marker is not remounted. */
const pointKey = (point: GeoPoint) =>
  `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`;

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
  const { filter, setFilter } = useFilter();
  const { locationBounds } = filter;
  const normalizedLocationBounds = locationBounds ?? undefined;

  const [mapElement, setMapElement] = useState<HTMLDivElement | null>(null);
  const [mapInstance, setMapInstance] = useState<Map | null>(null);
  const [vectorSource, setVectorSource] = useState<VectorSource | null>(null);
  const [pathSource, setPathSource] = useState<VectorSource | null>(null);
  const [pendingLocationBounds, setPendingLocationBounds] = useState<
    GeoBounds | undefined
  >(normalizedLocationBounds);
  const [hasFitted, setHasFitted] = useState(false);
  const [points, setPoints] = useState<GeoPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totalPins, setTotalPins] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showMovementPath, setShowMovementPath] = useState(false);
  const [representatives, setRepresentatives] = useState<MapRepresentative[]>([]);
  // Bumped on moveend so the representative selection re-runs against the new
  // pixel positions without re-running on unrelated renders.
  const [viewEpoch, setViewEpoch] = useState(0);

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

  const ageScale = useMemo(() => buildAgeScale(points), [points]);
  const ageLegend = useMemo(() => buildAgeLegend(ageScale), [ageScale]);

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
    const pathSource = new VectorSource();
    const baseLayer = new TileLayer({ source: new OSM() });
    // The path sits under the pins so pins stay clickable and legible over it.
    const pathLayer = new VectorLayer({ source: pathSource, style: movementPathStyle });
    const pinLayer = new VectorLayer({
      source,
      style: (feature) => markerStyleFor(feature.get("color") as string | undefined),
    });

    const map = new Map({
      target: mapElement,
      layers: [baseLayer, pathLayer, pinLayer],
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
    // Representative photos are positioned in pixel space, so any view change
    // invalidates the current selection.
    const bumpViewEpoch = () => setViewEpoch((epoch) => epoch + 1);

    map.on("moveend", notifyBounds);
    map.on("moveend", bumpViewEpoch);
    setMapInstance(map);
    setVectorSource(source);
    setPathSource(pathSource);

    return () => {
      resizeObserver.disconnect();
      viewport.removeEventListener("wheel", handleWheel);
      map.un("pointerdrag", markUserInteraction);
      map.un("dblclick", markUserInteraction);
      map.un("singleclick", markUserInteraction);
      map.un("moveend", notifyBounds);
      map.un("moveend", bumpViewEpoch);
      map.setTarget(undefined);
      setMapInstance(null);
      setVectorSource(null);
      setPathSource(null);
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
      // Read back by the layer's style function to pick the age-ramp colour.
      feature.set("color", colorForDate(ageScale, pointDate(point)));
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
  }, [ageScale, hasFitted, mapInstance, points, vectorSource]);

  // Movement path: pins in date order, joined into one line. Only pins that
  // carry a date can be placed on a timeline, so undated ones sit it out.
  useEffect(() => {
    if (!pathSource) {
      return;
    }
    pathSource.clear();
    if (!showMovementPath) {
      return;
    }
    const dated = points
      .flatMap((point) => {
        const date = pointDate(point);
        return date === undefined ? [] : [{ point, date }];
      })
      .sort((a, b) => a.date - b.date);
    if (dated.length < 2) {
      return;
    }
    pathSource.addFeatures([
      new Feature({
        geometry: new LineString(
          dated.map(({ point }) => fromLonLat([point.longitude, point.latitude])),
        ),
      }),
    ]);
  }, [pathSource, points, showMovementPath]);

  // Representative photos, chosen in pixel space so the result can neither
  // crowd the map nor scale with the pin count. Fullscreen only: the compact
  // map has no room for them.
  useEffect(() => {
    if (!isFullscreen || !mapInstance) {
      setRepresentatives([]);
      return;
    }
    const size = mapInstance.getSize();
    if (!size) {
      setRepresentatives([]);
      return;
    }
    const [width, height] = size;

    const candidates = points.flatMap((point) => {
      const pixel = mapInstance.getPixelFromCoordinate(
        fromLonLat([point.longitude, point.latitude]),
      );
      if (!pixel) return [];
      return [
        {
          key: pointKey(point),
          x: pixel[0],
          y: pixel[1],
          weight: point.count ?? 1,
          point,
        },
      ];
    });

    setRepresentatives(
      selectRepresentatives(candidates, { width, height }).map(({ key, point }) => ({
        key,
        coordinate: fromLonLat([point.longitude, point.latitude]),
        thumbnailUrl: point.path ? buildGeoPointThumbnailUrl(point) : undefined,
        label: point.name || point.path,
        color: colorForDate(ageScale, pointDate(point)),
      })),
    );
  }, [ageScale, isFullscreen, mapInstance, points, viewEpoch]);

  const clearMapFilter = () => {
    setPendingLocationBounds(undefined);
    setHasFitted(false);
  };

  const handleRepresentativeSelect = useCallback(
    (item: MapRepresentative) => {
      const view = mapInstance?.getView();
      if (!view) return;
      view.setCenter(item.coordinate);
      view.setZoom(Math.max(view.getZoom() ?? 0, 14));
      mapInstance?.set("userInteracted", true);
    },
    [mapInstance],
  );

  // Leaving fullscreen drops the representatives immediately rather than
  // letting a stale set linger over the compact map for a frame.
  const toggleFullscreen = () => {
    setIsFullscreen((previous) => {
      if (previous) setRepresentatives([]);
      return !previous;
    });
  };

  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsFullscreen(false);
        setRepresentatives([]);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen]);

  return (
    <div
      className={cx(
        css.card,
        compact && !isFullscreen ? css.compactCard : undefined,
        isFullscreen ? css.fullscreenCard : undefined,
      )}
    >
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
          <button
            className="btn btn-sm"
            onClick={toggleFullscreen}
            aria-pressed={isFullscreen}
          >
            {isFullscreen ? "Exit fullscreen" : "Explore fullscreen"}
          </button>
        </div>
      </div>

      <div className={css.mapShell}>
        <div
          ref={mapElementRef}
          className={cx(
            css.map,
            compact && !isFullscreen ? css.compactMap : undefined,
            isFullscreen ? css.fullscreenMap : undefined,
          )}
        />
        <MapPhotoMarkers
          map={mapInstance}
          items={representatives}
          onSelect={handleRepresentativeSelect}
        />
        {ageLegend.length > 0 ? (
          <div className={css.legend}>
            <small className={css.legendTitle}>{formatAgeRangeLabel(ageScale)}</small>
            <div className={css.legendStrip} aria-hidden="true">
              {ageLegend.map((step) => (
                <span
                  key={step.color}
                  className={css.legendSwatch}
                  style={{ background: step.color }}
                  title={step.label}
                />
              ))}
            </div>
            <div className={css.legendScale}>
              <small>older</small>
              <small>newer</small>
            </div>
          </div>
        ) : null}
        {showOverlay ? (
          <div className={css.overlay}>
            <Spinner label="Loading map data" />
          </div>
        ) : null}
      </div>

      <div className={css.statusRow}>
        <small>{pinSummary}</small>
        <button
          className={cx("btn", "btn-sm", css.movementToggle)}
          onClick={() => setShowMovementPath((shown) => !shown)}
          aria-pressed={showMovementPath}
          title="Trace these pins in date order"
        >
          ✈︎
        </button>
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
