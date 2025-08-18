import { Map, View } from 'ol';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import TileLayer from 'ol/layer/Tile';
import VectorLayer from 'ol/layer/Vector';
import 'ol/ol.css';
import { fromLonLat } from 'ol/proj';
import OSM from 'ol/source/OSM';
import VectorSource from 'ol/source/Vector';
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style';
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useFilter } from "./contexts/filterContext";
import { useSelected, useSelectedDispatch } from "./contexts/selectedContext";
import { useStyles } from "./MapView.styles";

type MapDataPoint = {
  path: string;
  details?: {
    geolocation?: {
      latitude: number;
      longitude: number;
    };
  };
};

export const MapViewInner: React.FC = () => {
  const styles = useStyles();
  const { filter, url } = useFilter();
  const selected = useSelected();
  const selectedDispatch = useSelectedDispatch();

  const [mapData, setMapData] = useState<MapDataPoint[] | null>(null);
  const [loading, setLoading] = useState(true);
  const mapRef = useRef<HTMLDivElement>(null);

  // Initialize map
  const [map, vectorSource] = useMemo(() => {
    if (!mapRef.current || mapRef.current.children.length > 0) {
      return [null, null]
    }

    const source = new VectorSource();
    console.log('new map')
    const map = new Map({
      target: mapRef.current,
      layers: [
        new TileLayer({
          source: new OSM(),
        }),
        new VectorLayer({
          source
        }),
      ],
      view: new View({
        center: fromLonLat([0, 20]),
        zoom: 2,
      }),
    })
    return [map, source];
  }, [mapRef.current]);

  // Load map data
  useEffect(() => {
    const loadMapData = async () => {
      setLoading(true);
      const mapURL = new URL(url);
      mapURL.searchParams.set('details', "geolocation");

      const response = await fetch(mapURL.toString());
      const data = await response.json();
      console.log('Received map data:', data);
      setMapData(data);
      setLoading(false);
    }

    loadMapData();
  }, [filter]);

  // Update markers when data or map changes
  useEffect(() => {
    if (vectorSource === null || map === null || mapData === null) {
      return;
    }
    vectorSource.clear();

    // Filter points with valid geolocation
    const features = mapData.filter((item): item is MapDataPoint & { details: { geolocation: { latitude: number; longitude: number; }; }; } => 
      item.details?.geolocation?.latitude !== undefined && 
      item.details?.geolocation?.longitude !== undefined
    ).map(item=>{
      const { latitude, longitude } = item.details.geolocation;
      
      const feature = new Feature({
        geometry: new Point(fromLonLat([longitude, latitude])),
        path: item.path,
      });

      const isSelected = selected.has(item.path);

      feature.setStyle(new Style({
        image: new CircleStyle({
          radius: isSelected ? 12 : 8,
          fill: new Fill({ color: isSelected ? '#ff4444' : '#0078d4' }),
          stroke: new Stroke({ color: 'white', width: isSelected ? 3 : 2 }),
        }),
      }));
      return feature;
    });

    if (features.length === 0){
      return;
    }

    vectorSource.addFeatures(features);

    const clickHandler = (event: any) => {
      map.forEachFeatureAtPixel(event.pixel, (feature) => {
        const path = feature.get('path');
        if (path) {
          console.log('Photo clicked:', path);
          // Toggle selection
          selectedDispatch({ type: 'toggle', payload: path });
        }
      });
    };

    map.on('click', clickHandler);
    
    map.getView().fit(vectorSource.getExtent(), { padding: [50, 50, 50, 50] });

    return () => {
      map.un('click', clickHandler);
    };
  }, [vectorSource, map, mapData]);

  return (
    <div className={styles.mapContainer}>
      <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 1000, background: 'white', padding: '5px', fontSize: '12px' }}>
        Debug: {mapData?.length} items loaded, {mapData?.filter(item => item.details?.geolocation).length} with GPS
      </div>
      {loading &&<div style={{position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1000, background: 'white', padding: '5px', fontSize: '12px'}}>Loading map data...</div>}
      <div ref={mapRef} className={styles.mapWrapper}></div>
    </div>
  );
};

export const MapView = memo(MapViewInner);