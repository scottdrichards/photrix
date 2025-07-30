import { memo, useEffect, useState } from "react";
import { Media } from "./Media";
import { useStyles } from "./ThumbnailViewer.styles";
import { mediaURLBase } from "./data/api";
import { Filters } from "./filters/Filters";
import { useSelected, useSelectedDispatch } from "./selectedContext";
import { processLines } from "./streamData";

const minSize = 100;
const maxSize = 300;

type Params = {
  directoryPath: string | null;
  includeSubfolders?: boolean;
  selectFolder: (path: string) => void;
};

export const ThumbnailViewer: React.FC<Params> = memo((params) => {
  const { directoryPath, includeSubfolders, selectFolder } = params;
  const [search, setSearch] = useState("");

  type Thumbnail = {
    path: string;
    type: "file" | "folder";
    details:{
      resolution?: { width: number; height: number };
    };
  }
  const [thumbnails, setThumbnails] = useState<Array<Thumbnail>>([]);
  const [loading, setLoading] = useState(false);
  const [size, setSize] = useState(0.2 * (maxSize - minSize) + minSize);
  const styles = useStyles();

  // Thumbnail item to avoid rerendering the list when selection changes
  const ThumbnailItem = ({ thumbnail }: { thumbnail: Thumbnail }) => {
    const selectedDispatch = useSelectedDispatch();
    const onClick = (e: React.MouseEvent) => {
      const path = thumbnail.path;
      const type = thumbnail.type;
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
    }
    const ratio = (thumbnail.details?.resolution?.width || 1) / (thumbnail.details?.resolution?.height || 1);
    const style = {
      "--size": `${size}px`,
      "--ratio": ratio,
    } as React.CSSProperties;
    
    return (
        thumbnail.type === "folder" ? <></> :
          <Media
            path={thumbnail.path}
            width={100}
            style={style}
            thumbnailBehavior= "never"
            fullSizeBehavior={{ fetchPriority: "low", loading: "lazy" }}
            
            key={thumbnail.path}
            data-path={thumbnail.path}
            data-type={thumbnail.type}
            className={styles.thumbnail}
            onClick={onClick}
          />
    );
  }

  const url = new URL(directoryPath?.toString()??'', mediaURLBase);
  console.log({url: url.toString()});
  url.searchParams.set("includedAttributes", JSON.stringify(["resolution"]));
  if (includeSubfolders) {
    url.searchParams.set("includeSubfolders", "true");
  }
  if (search) {
    url.searchParams.set("search", search);
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
          thumbnailData = thumbnailData
            .concat(...linesChunk.map((line) => JSON.parse(line)))
          setThumbnails(thumbnailData);
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

  return (
    <div className={styles.root}>
      <Filters search={search} setSearch={setSearch} />
      <div className={styles.gallery}>
        {(includeSubfolders ? thumbnails.filter((t) => t.type !== "folder") : thumbnails)
          .map((thumbnail) => (
            <ThumbnailItem key={thumbnail.path} thumbnail={thumbnail} />
          ))}
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