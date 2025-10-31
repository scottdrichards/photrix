import { useEffect, useRef } from "react";
import { makeStyles, tokens } from "@fluentui/react-components";
import Map from "ol/Map";
import View from "ol/View";
import TileLayer from "ol/layer/Tile";
import OSM from "ol/source/OSM";
import { fromLonLat, toLonLat } from "ol/proj";
import "ol/ol.css";

const useStyles = makeStyles({
  container: {
    height: "300px",
    width: "100%",
    borderRadius: tokens.borderRadiusMedium,
    overflow: "hidden",
    border: `1px solid ${tokens.colorNeutralStroke1}`,
  },
});

export type LocationBounds = {
  minLatitude?: number;
  maxLatitude?: number;
  minLongitude?: number;
  maxLongitude?: number;
};

export type MapFilterProps = {
  value?: LocationBounds;
  onChange: (bounds?: LocationBounds) => void;
};

export const MapFilter = ({ onChange }: MapFilterProps) => {
  const styles = useStyles();
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<Map | null>(null);

  useEffect(() => {
    if (!mapRef.current) {
      return;
    }

    const map = new Map({
      target: mapRef.current,
      layers: [
        new TileLayer({
          source: new OSM(),
        }),
      ],
      view: new View({
        center: fromLonLat([0, 0]),
        zoom: 2,
      }),
    });

    mapInstanceRef.current = map;

    const updateBounds = () => {
      const view = map.getView();
      const extent = view.calculateExtent(map.getSize());
      const [minLon, minLat] = toLonLat([extent[0], extent[1]]);
      const [maxLon, maxLat] = toLonLat([extent[2], extent[3]]);

      onChange({
        minLatitude: minLat,
        maxLatitude: maxLat,
        minLongitude: minLon,
        maxLongitude: maxLon,
      });
    };

    map.on("moveend", updateBounds);

    return () => {
      map.setTarget(undefined);
      mapInstanceRef.current = null;
    };
  }, [onChange]);

  return <div ref={mapRef} className={styles.container} />;
};
