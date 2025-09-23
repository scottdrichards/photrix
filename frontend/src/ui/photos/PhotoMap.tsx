import React, { useEffect, useRef, useCallback } from 'react';
// OpenLayers core + CSS (controls & default styles)
import 'ol/ol.css';
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import OSM from 'ol/source/OSM';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import { Style, Icon } from 'ol/style';
import { fromLonLat, toLonLat } from 'ol/proj';
import { boundingExtent } from 'ol/extent';
import { usePhotos } from '../../state/photos/PhotosContext';
import type { Photo } from '../../types';

export const PhotoMap: React.FC = () => {
  const mapRef = useRef<HTMLDivElement | null>(null);
  const mapObj = useRef<Map | null>(null);
  const vectorSourceRef = useRef<VectorSource | null>(null);
  const { photos, setViewportBounds } = usePhotos();

  // Helper to push current visible extent (in WGS84) into filtering state
  const updateBounds = useCallback(() => {
    const map = mapObj.current;
    if (!map) return;
    // Ensure map size is up to date (important in flex layouts)
    map.updateSize();
    const view = map.getView();
    let size = map.getSize();
    if (!size || !Array.isArray(size)) {
      // Fallback: force a reflow and try again next frame
      requestAnimationFrame(() => updateBounds());
      return;
    }
    const extent = view.calculateExtent(size as [number, number]);
    const [minX, minY, maxX, maxY] = extent;
    const [minLng, minLat] = toLonLat([minX, minY]);
    const [maxLng, maxLat] = toLonLat([maxX, maxY]);
    if (Number.isNaN(minLat) || Number.isNaN(maxLat)) {
      return; // Skip invalid
    }
    console.debug('Map updateBounds extent ->', { minLat, maxLat, minLng, maxLng });
    setViewportBounds({ minLat, maxLat, minLng, maxLng });
  }, [setViewportBounds]);

  // Initialize map
  useEffect(() => {
    if (!mapRef.current || mapObj.current) return;

    const vectorSource = new VectorSource();
    vectorSourceRef.current = vectorSource;

    const vectorLayer = new VectorLayer({
      source: vectorSource,
      style: new Style({
        image: new Icon({
          anchor: [0.5, 1],
          anchorXUnits: 'fraction',
            anchorYUnits: 'fraction',
            src: 'data:image/svg+xml;utf8,' + encodeURIComponent(`
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="32" viewBox="0 0 24 32">
                <path d="M12 0C5.4 0 0 5.4 0 12c0 7.2 12 20 12 20s12-12.8 12-20c0-6.6-5.4-12-12-12z" fill="#667eea"/>
                <circle cx="12" cy="12" r="4" fill="white"/>
              </svg>
            `)
        })
      })
    });

    const map = new Map({
      target: mapRef.current,
      layers: [
        new TileLayer({ source: new OSM() }),
        vectorLayer
      ],
      view: new View({ center: fromLonLat([0,0]), zoom: 2 })
    });

    // Use map's moveend event (fires after interactions & animations) for more reliable updates
    const onMoveEnd = () => {
      updateBounds();
    };
    map.on('moveend', onMoveEnd);

    // Throttled center / zoom change listeners as fallback (sometimes moveend is quiet in programmatic fits)
    let rafId: number | null = null;
    const scheduleUpdate = (reason: string) => {
      if (rafId !== null) return; // already scheduled
      rafId = requestAnimationFrame(() => {
        rafId = null;
        console.debug('Scheduled bounds update due to', reason);
        updateBounds();
      });
    };
    const view = map.getView();
    const centerListener = () => scheduleUpdate('center change');
    const resListener = () => scheduleUpdate('resolution change');
    view.on('change:center', centerListener);
    view.on('change:resolution', resListener);

    // After first full render ensure bounds captured
    map.once('rendercomplete', () => {
      console.debug('Map rendercomplete - initial bounds update');
      updateBounds();
    });

    // Initial bounds after first render
  setTimeout(updateBounds, 0);

    // Resize observer to keep map extent consistent with container
    const ro = new ResizeObserver(() => updateBounds());
    if (mapRef.current) ro.observe(mapRef.current);

    mapObj.current = map;

    return () => {
      map.un('moveend', onMoveEnd);
      view.un('change:center', centerListener);
      view.un('change:resolution', resListener);
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (mapRef.current) ro.disconnect();
    };
  }, [setViewportBounds, updateBounds]);

  // Update markers when photos change
  useEffect(() => {
    const map = mapObj.current;
    const vectorSource = vectorSourceRef.current;
    if (!map || !vectorSource) return;

    vectorSource.clear();
  // Exclude photos lacking coordinates (null / undefined) to prevent null-island markers
  const locPhotos: Photo[] = photos.filter(p => p.latitude != null && p.longitude != null);

    locPhotos.forEach(p => {
      const f = new Feature({
        geometry: new Point(fromLonLat([p.longitude!, p.latitude!])),
        photoId: p.id
      });
      vectorSource.addFeature(f);
    });

  if (locPhotos.length === 0) return;
    const coords = locPhotos.map(p => fromLonLat([p.longitude!, p.latitude!]));
    if (coords.length === 1) {
      map.getView().setCenter(coords[0]);
      map.getView().setZoom(15);
    } else {
      const extent = boundingExtent(coords);
      map.getView().fit(extent, { padding: [40,40,40,40], maxZoom: 16 });
    }
  }, [photos]);

  return (
    <div 
      ref={mapRef}
      style={{
        width: '100%',
        height: 300,
        borderRadius: 8,
        overflow: 'hidden',
        position: 'relative'
      }}
    />
  );
};
