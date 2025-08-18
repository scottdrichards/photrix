import { useEffect, useState, useRef } from "react";
import { useFilter } from "./contexts/filterContext";
import { useSelected, useSelectedDispatch } from "./contexts/selectedContext";
import { useStyles } from "./MapView.styles";
import 'ol/ol.css';
import { Map, View } from 'ol';
import TileLayer from 'ol/layer/Tile';
import OSM from 'ol/source/OSM';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Feature from 'ol/Feature';
import Point from 'ol/geom/Point';
import { fromLonLat } from 'ol/proj';
import { Style, Fill, Stroke, Circle as CircleStyle } from 'ol/style';

type MapDataPoint = {
  path: string;
  details?: {
    geolocation?: {
      latitude: number;
      longitude: number;
    };
  };
};

export const MapView: React.FC = () => {
  const styles = useStyles();
  const { filter } = useFilter();
  const selected = useSelected();
  const selectedDispatch = useSelectedDispatch();
  const [mapData, setMapData] = useState<MapDataPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [map, setMap] = useState<Map | null>(null);
  const [vectorLayer, setVectorLayer] = useState<VectorLayer<VectorSource> | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);

  // Initialize map
  useEffect(() => {
    console.log('Map initialization effect triggered, mapRef.current:', !!mapRef.current);
    if (!mapRef.current) return;

    // Check if map already exists
    if (map) {
      console.log('Map already initialized, skipping');
      return;
    }

    // Small delay to ensure DOM is ready
    const initMap = () => {
      const vectorSource = new VectorSource();
      const newVectorLayer = new VectorLayer({
        source: vectorSource,
      });

      const newMap = new Map({
        target: mapRef.current!,
        layers: [
          new TileLayer({
            source: new OSM(),
          }),
          newVectorLayer,
        ],
        view: new View({
          center: fromLonLat([0, 20]),
          zoom: 2,
        }),
      });

      console.log('Map created successfully');
      setMap(newMap);
      setVectorLayer(newVectorLayer);

      // Force map to resize after a moment
      setTimeout(() => {
        newMap.updateSize();
        console.log('Map size updated');
      }, 100);
    };

    const timeoutId = setTimeout(initMap, 100);

    return () => {
      console.log('Cleaning up map');
      clearTimeout(timeoutId);
    };
  }, []);

  // Load map data
  useEffect(() => {
    const loadMapData = async () => {
      try {
        setLoading(true);
        console.log('Loading map data for filter:', filter);
        
        // Use the regular API with details parameter
        const url = new URL(filter.parentFolder ?? "", `${window.location.origin}/media/`);
        url.searchParams.set("details", "geolocation");
        
        Object.entries(filter).forEach(([key, value]) => {
          if (value !== undefined && key !== 'parentFolder') {
            url.searchParams.set(key, JSON.stringify(value));
          }
        });
        
        console.log('Fetching from URL:', url.toString());
        const response = await fetch(url);
        const data = await response.json();
        console.log('Received map data:', data);
        setMapData(data);
      } catch (error) {
        console.error('Error loading map data:', error);
      } finally {
        setLoading(false);
      }
    };

    loadMapData();
  }, [filter]);

  // Update markers when data or map changes
  useEffect(() => {
    console.log('Map effect triggered:', { 
      hasMap: !!map, 
      hasVectorLayer: !!vectorLayer, 
      dataLength: mapData.length,
      mapData: mapData.slice(0, 3) // Show first 3 items for debugging
    });

    if (!map || !vectorLayer) {
      console.log('Map or vector layer not ready');
      return;
    }

    if (!mapData.length) {
      console.log('No map data available');
      return;
    }

    const source = vectorLayer.getSource();
    if (!source) {
      console.log('No vector source available');
      return;
    }

    // Clear existing features
    source.clear();

    // Filter points with valid geolocation
    const validPoints = mapData.filter(item => 
      item.details?.geolocation?.latitude && 
      item.details?.geolocation?.longitude
    );

    console.log('Valid points with geolocation:', validPoints.length);

    // Add simple pin markers for each photo
    validPoints.forEach((item, index) => {
      const { latitude, longitude } = item.details!.geolocation!;
      console.log(`Adding pin ${index}:`, { latitude, longitude, path: item.path });
      
      const feature = new Feature({
        geometry: new Point(fromLonLat([longitude, latitude])),
        path: item.path
      });

      // Check if this item is selected
      const isSelected = selected.has(item.path);

      // Style based on selection state
      feature.setStyle(new Style({
        image: new CircleStyle({
          radius: isSelected ? 12 : 8,
          fill: new Fill({ color: isSelected ? '#ff4444' : '#0078d4' }),
          stroke: new Stroke({ color: 'white', width: isSelected ? 3 : 2 }),
        }),
      }));

      source.addFeature(feature);
    });

    console.log('Added features to map:', source.getFeatures().length);

    // Add click handler for pins
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

    // Fit map to show all pins if we have data
    if (validPoints.length > 0) {
      const extent = source.getExtent();
      console.log('Map extent:', extent);
      if (extent && extent.every(coord => isFinite(coord))) {
        map.getView().fit(extent, { padding: [50, 50, 50, 50] });
        console.log('Fitted map to extent');
      }
    }

    return () => {
      map.un('click', clickHandler);
    };
  }, [map, vectorLayer, mapData, selected, selectedDispatch]);

  if (loading) {
    return (
      <div className={styles.mapContainer}>
        <div className={styles.loadingSpinner}>
          Loading map data...
        </div>
        <div ref={mapRef} className={styles.mapWrapper} />
      </div>
    );
  }

  return (
    <div className={styles.mapContainer}>
      <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 1000, background: 'white', padding: '5px', fontSize: '12px' }}>
        Debug: {mapData.length} items loaded, {mapData.filter(item => item.details?.geolocation).length} with GPS
      </div>
      <div ref={mapRef} className={styles.mapWrapper} />
    </div>
  );
};
