import { useEffect, useRef, useState } from "react";
import Map from "ol/Map";
import View from "ol/View";
import Feature from "ol/Feature";
import Point from "ol/geom/Point";
import TileLayer from "ol/layer/Tile";
import VectorLayer from "ol/layer/Vector";
import OSM from "ol/source/OSM";
import VectorSource from "ol/source/Vector";
import { fromLonLat } from "ol/proj";
import "ol/ol.css";
import { markerStyle } from "./MapFilter.styles";
import css from "./MiniMap.module.css";

interface MiniMapProps {
  latitude?: number;
  longitude?: number;
}

export const MiniMap = ({ latitude, longitude }: MiniMapProps) => {
  const mapElementRef = useRef<HTMLDivElement>(null);
  const [mapInstance, setMapInstance] = useState<Map | null>(null);
  const [vectorSource, setVectorSource] = useState<VectorSource | null>(null);

  const hasLocation = latitude !== undefined && longitude !== undefined;

  useEffect(() => {
    if (!mapElementRef.current) {
      return;
    }

    const source = new VectorSource();
    const baseLayer = new TileLayer({ source: new OSM() });
    const pinLayer = new VectorLayer({ source, style: markerStyle });

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

    setMapInstance(map);
    setVectorSource(source);

    return () => {
      resizeObserver.disconnect();
      map.setTarget(undefined);
    };
  }, []);

  // Update map with location marker when location changes
  useEffect(() => {
    if (!mapInstance || !vectorSource) {
      return;
    }

    vectorSource.clear();

    if (!hasLocation) {
      return;
    }

    const feature = new Feature({
      geometry: new Point(fromLonLat([longitude, latitude])),
    });
    vectorSource.addFeatures([feature]);

    mapInstance
      .getView()
      .animate(
        { center: fromLonLat([longitude, latitude]), zoom: 15, duration: 300 },
      );
  }, [mapInstance, vectorSource, hasLocation, latitude, longitude]);

  if (!hasLocation) {
    return null;
  }

  return (
    <div className={css.mapContainer}>
      <small className={css.label}>Location</small>
      <div ref={mapElementRef} className={css.miniMap} />
    </div>
  );
};
