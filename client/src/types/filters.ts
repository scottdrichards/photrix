export type FilterState = {
  directories?: string[];
  minRating?: number;
  tags?: string[];
  dateRange?: {
    start?: string;
    end?: string;
  };
  location?: {
    minLatitude?: number;
    maxLatitude?: number;
    minLongitude?: number;
    maxLongitude?: number;
  };
  cameraMake?: string[];
  cameraModel?: string[];
};
