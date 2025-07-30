import { memo, useEffect, useState } from "react";
import { Media } from "./Media";
import { Filters } from "./filters/Filters";
import { processLines } from "./streamData";
import { useStyles } from "./ThumbnailViewer.styles";
import { mediaURLBase } from "./data/api";

const minSize = 100;
const maxSize = 300;

const mediaStyle = { width: "100%", height: "100%", objectFit: "cover" } as const

type Params = {
  directoryPath: string | null;
  includeSubfolders?: boolean;
  selected: string[];
  setSelected: (paths: string[]) => void;
  selectFolder: (path: string) => void;
};

export const ThumbnailViewer: React.FC<Params> = (params) => {
  const { directoryPath, includeSubfolders, selected, setSelected,selectFolder } =
    params;
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

  const onClick = (e: React.MouseEvent) => {
    const path = (e.currentTarget as HTMLDivElement).dataset.path;
    const type = (e.currentTarget as HTMLDivElement).dataset.type;
    if (type === "folder") {
      if (path) {
        selectFolder(path);
      }
      return;
    }

    if (!path) return;
    const selectMultipleMode = e.ctrlKey ||( e.target instanceof HTMLImageElement && e.target.classList.contains("select-indicator"));
    if (!selectMultipleMode
    ) {
      setSelected([path]);
      return;
    }
    if (selected.includes(path)) {
      setSelected(selected.filter((s) => s !== path));
    } else {
      setSelected([...(selected || []), path]);
    }
  }

  const url = new URL(`${directoryPath??''}`, mediaURLBase);
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
          {thumbnails.map((thumbnail) => {
            const ratio = (thumbnail.details?.resolution?.width || 1) / (thumbnail.details?.resolution?.height || 1);
            return (
              <div
                key={thumbnail.path}
                data-path={thumbnail.path}
                data-type={thumbnail.type}
                className={styles.thumbnail}
                style={{
                  "--size": `${size}px`,
                  "--ratio": ratio,
                } as React.CSSProperties}
                onClick={onClick}
              >
                <div
                  className="select-indicator"
                  style={{
                    backgroundColor: selected?.includes(thumbnail.path)
                      ? "blue"
                      : "white",
                    display: selected.length ? "initial" : "none",
                  }}
                ></div>
                {thumbnail.type === "folder" ? <div><div>📁</div>{thumbnail.path}</div> : 
                <Media
                  path={thumbnail.path}
                  width={100}
                  style={mediaStyle}
                  thumbnailBehavior={{ fetchPriority: "low", loading: "lazy" }}
                  fullSizeBehavior="never"
                />}
              </div>
            );
          })}
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
};