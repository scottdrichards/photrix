import { useEffect, useRef } from "react";
import type { PhotoItem } from "../../api";
import { useOptionalFilter } from "../filter/FilterContext";

/**
 * Feedback #164: a folder in the file-info path opens that folder. Search and
 * content filters are dropped so all the photo's neighbours show. The viewer
 * closes first and the folder is applied in the effect below, in the same
 * render as the URL's preview going away, so it is one history entry: Back
 * returns to the search with this photo open.
 *
 * Returns undefined outside a filter provider, where there is no folder to open.
 */
export const useFolderOpen = (
  photo: PhotoItem | null,
  setSelected: (photo: PhotoItem | null) => void,
) => {
  const filterContext = useOptionalFilter();
  const pendingFolderRef = useRef<string | null>(null);
  const openFolder = filterContext
    ? (folderPath: string) => {
        pendingFolderRef.current = folderPath;
        setSelected(null);
      }
    : undefined;
  const setFilter = filterContext?.setFilter;
  useEffect(() => {
    const folderPath = pendingFolderRef.current;
    if (photo || folderPath === null || !setFilter) return;
    pendingFolderRef.current = null;
    setFilter((prev) => ({
      ...prev,
      path: folderPath,
      semanticQuery: undefined,
      expandToFolder: false,
      peopleInImageFilter: undefined,
      faceClusterFilter: undefined,
      faceAttributeFilter: undefined,
      cameraModelFilter: undefined,
      lensFilter: undefined,
      ratingFilter: undefined,
      locationBounds: undefined,
      dateRange: undefined,
    }));
  }, [photo, setFilter]);
  return openFolder;
};
