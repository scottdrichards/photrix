import { CSSProperties, memo, useCallback, useEffect, useState } from "react";
import { Media } from "./Media";
import { useStyles } from "./ThumbnailViewer.styles";
import { mediaURLBase } from "./data/api";
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
  details:{
    aspectRatio?: number;
  }
};

export const ThumbnailViewer: React.FC = memo(() => {
  const { filter } = useFilter();

  const [thumbnails, setThumbnails] = useState<Array<ThumbnailData>>([]);
  const [loading, setLoading] = useState(false);
  const [size, setSize] = useState(0.2 * (maxSize - minSize) + minSize);
  const styles = useStyles();
  const selectedDispatch = useSelectedDispatch();

  const url = new URL(mediaURLBase);
  url.searchParams.set("details","aspectRatio");
  const {parentFolder, ...restFilter} = filter;
  if (parentFolder) {
    // Ensure directoryPath doesn't start with / to avoid replacing the entire path
    const cleanPath = parentFolder.startsWith('/') ? parentFolder.slice(1) : parentFolder;
    url.pathname = url.pathname + cleanPath;
  }
  console.log({url: url.toString()});
  if (!restFilter.excludeSubfolders) {
    url.searchParams.set("excludeSubfolders", "true");
  }
  if (restFilter) {
    Object.entries(restFilter).filter(([_, value]) => value !== undefined).forEach(([key, value]) => {
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
          const newThumbnailData = linesChunk.flatMap(line => JSON.parse(line) as ThumbnailData).filter(t=>t.path.match(thumbnailFileRegex));
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
      <div style={{ "--size": `${size}px` } as CSSProperties} className={styles.gallery}>
        {thumbnails.map(({path, details}) => {
          const isVideo = path.match(/\.(mp4|mov|avi|mkv|webm|flv|m4v)$/i);
          if (isVideo) {
            return (
              <div
                key={path}
                data-path={path}
                className={styles.thumbnail}
                style={{ display:'flex', alignItems:'center', justifyContent:'center', fontSize:'12px', cursor:'pointer', border:'1px solid #555', overflow:'hidden', "--ratio": '1'} as CSSProperties}
                onClick={(e:any) => {
                  const selectMultipleMode = e.ctrlKey;
                  if (selectMultipleMode){
                    selectedDispatch({ type: 'toggle', payload: path });
                  } else {
                    selectedDispatch({ type: 'set', payload: new Set([path]) });
                  }
                }}
                title={path}
              >{path.split('/').pop()}</div>
            );
          }
          return <Media        
              path={path}
              key={path}
              thumbnailBehavior= "never"
              fullSizeBehavior={{ fetchPriority: "low", loading: "lazy" }}
              data-path={path}
              className={styles.thumbnail}
              style={{"--ratio": details.aspectRatio?.toString() || "1"} as CSSProperties}
              onLoad={onThumbnailLoad}
              onClick={onThumbnailClick}
            />
        })}
          {thumbnails.length === 0 && !loading && <div>No thumbnails found</div>}
        <div style={{ flexGrow: 1}}></div> {/* Filler to keep the last image(s) from growing */}
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