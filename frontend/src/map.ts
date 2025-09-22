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
import type { Photo } from './types.js';

export class PhotoMap {
  private map: Map;
  private vectorSource: VectorSource;
  private vectorLayer: VectorLayer;
  private photos: Photo[] = [];
  private onViewportChange?: (bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number; }) => void;

  constructor(targetId: string) {
    // Create vector source for photo markers
    this.vectorSource = new VectorSource();

    // Create vector layer for photo markers
    this.vectorLayer = new VectorLayer({
      source: this.vectorSource,
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

    // Initialize the map
    this.map = new Map({
      target: targetId,
      layers: [
        new TileLayer({
          source: new OSM()
        }),
        this.vectorLayer
      ],
      view: new View({
        center: fromLonLat([0, 0]),
        zoom: 2
      })
    });

    // Listen for view changes
    this.map.getView().on('change', () => {
      this.handleViewportChange();
    });
  }

  public setPhotos(photos: Photo[]): void {
    this.photos = photos.filter(photo => photo.latitude && photo.longitude);
    this.updateMarkers();
    this.fitToPhotos();
  }

  public setViewportChangeHandler(handler: (bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number; }) => void): void {
    this.onViewportChange = handler;
  }

  private updateMarkers(): void {
    this.vectorSource.clear();

    this.photos.forEach(photo => {
      if (photo.latitude && photo.longitude) {
        const feature = new Feature({
          geometry: new Point(fromLonLat([photo.longitude, photo.latitude])),
          photo: photo
        });

        this.vectorSource.addFeature(feature);
      }
    });
  }

  private fitToPhotos(): void {
    if (this.photos.length === 0) {
      // Default view if no photos with location
      this.map.getView().setCenter(fromLonLat([0, 0]));
      this.map.getView().setZoom(2);
      return;
    }

    const coordinates = this.photos.map(photo => 
      fromLonLat([photo.longitude!, photo.latitude!])
    );

    if (coordinates.length === 1) {
      // Single photo - center on it
      this.map.getView().setCenter(coordinates[0]);
      this.map.getView().setZoom(15);
    } else {
      // Multiple photos - fit to bounds
      const extent = boundingExtent(coordinates);
      this.map.getView().fit(extent, {
        padding: [50, 50, 50, 50],
        maxZoom: 16
      });
    }
  }

  private handleViewportChange(): void {
    if (!this.onViewportChange) return;

    const view = this.map.getView();
    const extent = view.calculateExtent();
    const [minX, minY, maxX, maxY] = extent;

    // Convert from map projection to WGS84
    const [minLng, minLat] = toLonLat([minX, minY]);
    const [maxLng, maxLat] = toLonLat([maxX, maxY]);

    this.onViewportChange({
      minLat,
      maxLat,
      minLng,
      maxLng
    });
  }

  public getPhotosInView(): Photo[] {
    const view = this.map.getView();
    const extent = view.calculateExtent();
    const [minX, minY, maxX, maxY] = extent;

    // Convert from map projection to WGS84
    const [minLng, minLat] = toLonLat([minX, minY]);
    const [maxLng, maxLat] = toLonLat([maxX, maxY]);

    return this.photos.filter(photo => {
      if (!photo.latitude || !photo.longitude) return false;
      return (
        photo.latitude >= minLat &&
        photo.latitude <= maxLat &&
        photo.longitude >= minLng &&
        photo.longitude <= maxLng
      );
    });
  }

  public destroy(): void {
    this.map.setTarget(undefined);
  }
}