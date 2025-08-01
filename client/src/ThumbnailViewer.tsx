import { CSSProperties, memo, useCallback, useEffect, useState } from "react";
import { Media } from "./Media";
import { useStyles } from "./ThumbnailViewer.styles";
import { mediaURLBase } from "./data/api";
import { Filters } from "./filters/Filters";
import { useSelectedDispatch } from "./contexts/selectedContext";
import { processLines } from "./streamData";
import { useFilter } from "./contexts/filterContext";

const minSize = 100;
const maxSize = 300;

const thumbnailImageFileExtensions = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tiff", ".heic", ".heif"];
const thumbnailVideoFileExtensions = [".mp4", ".webm", ".avi", ".mov", ".mkv", ".flv", ".m4v", ".webm", ".ogv", ".hevc", ".h264"];
const thumbnailFileRegex = new RegExp(`(${thumbnailImageFileExtensions.join("|")}|${thumbnailVideoFileExtensions.join("|")})$`, "i");

type ThumbnailData = {
  path: string;
  type: "file" | "folder";
};


type Params = {
  directoryPath: string | null;
  includeSubfolders?: boolean;
  selectFolder: (path: string) => void;
};

export const ThumbnailViewer: React.FC<Params> = memo((params) => {
  const { directoryPath, includeSubfolders, selectFolder } = params;
  const {filter} = useFilter();

  const [thumbnails, setThumbnails] = useState<Array<ThumbnailData>>([]);
  const [loading, setLoading] = useState(false);
  const [size, setSize] = useState(0.2 * (maxSize - minSize) + minSize);
  const styles = useStyles();
  const selectedDispatch = useSelectedDispatch();

  const url = new URL(directoryPath?.toString()??'', mediaURLBase);
  console.log({url: url.toString()});
  // url.searchParams.set("includedAttributes", JSON.stringify(["resolution"]));
  if (includeSubfolders) {
    url.searchParams.set("includeSubfolders", "true");
  }
  if (filter) {
    Object.entries(filter).filter(([_, value]) => value !== undefined).forEach(([key, value]) => {
      url.searchParams.set(key, JSON.stringify(value));
    });
  }
  const urlString = url.toString();

  useEffect(() => {
    if (!urlString) return;
    const abortController = new AbortController();
    const { signal } = abortController;
    (async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (signal.aborted) {
        // debounced
        return;
      }
      setLoading(true);
      setThumbnails([]);
      try{
        const response = await fetch(urlString, {
          signal,
        });
        let thumbnailData:typeof thumbnails = [];
        for await (const linesChunk of processLines(response)) {
          const newThumbnailData = linesChunk.map((line) => JSON.parse(line) as ThumbnailData).filter(t=>t.path.match(thumbnailFileRegex));
          thumbnailData = thumbnailData
            .concat(...newThumbnailData)
          setThumbnails([...thumbnailData, ...newThumbnailData]);
        }
        setLoading(false);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          console.log("Fetch aborted");
        } else {
          console.error("Error fetching thumbnails:", e);
        }
      }
    })();
    return () => {
      abortController.abort();
      setLoading(false);
      setThumbnails([]);
    };
  }, [urlString]);

  const onThumbnailClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    // Grab the attributes from the clicked image so that we can reuse the handler for all images
    const path = e.currentTarget.attributes.getNamedItem("data-path")?.value;
    const type = e.currentTarget.attributes.getNamedItem("data-type")?.value;
    if (type === "folder") {
      if (path) {
        selectFolder(path);
      }
      return;
    }
    if (!path) return;

    const selectMultipleMode = e.ctrlKey || (e.target instanceof HTMLImageElement && e.target.classList.contains("select-indicator"));
    if (selectMultipleMode){
      selectedDispatch({ type: 'toggle', payload: path });
    } else{
      selectedDispatch({type:"set", payload: new Set([path])});
    }
  }, []);

  const onThumbnailLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const ratio = e.currentTarget.naturalWidth / e.currentTarget.naturalHeight;
    e.currentTarget.style.setProperty("--ratio", ratio.toString());
  }, []);

  return (
    <div className={styles.root}>
      <Filters />
      <div style={{ "--size": `${size}px` } as CSSProperties} className={styles.gallery}>
        {(includeSubfolders ? thumbnails.filter((t) => t.type !== "folder") : thumbnails)
          .map(({path, type}) => (    type === "folder" ? <></> :
          <Media        
            path={path}
            width={100}
            thumbnailBehavior= "never"
            fullSizeBehavior={{ fetchPriority: "low", loading: "lazy" }}
            key={path}
            data-path={path}
            data-type={type}
            className={styles.thumbnail}
            onLoad={onThumbnailLoad}
            onClick={onThumbnailClick}
          />))}
        <div style={{ flexGrow: Infinity}}></div> {/* Filler to keep the last image(s) from growing */}
        {loading && <div>Loading...</div>}
        <input
          type="range"
          min={minSize}
          max={maxSize}
          value={size}
          onChange={(e) => {
            const v = parseInt(e.currentTarget.value);
            setSize(v);
          }}
          className={styles.sizeSlider}
        />
      </div>
    </div>
  );
})