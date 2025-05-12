import { useEffect, useState } from "react";
import { Media } from "./Media";
import { Filters } from "./filters/Filters";
import { processLines } from "./streamData";
import { useStyles } from "./ThumbnailViewer.styles";
import { mediaURLBase } from "./data/api";

const minSize = 100;
const maxSize = 300;

type Params = {
  directoryPath: string | undefined;
  includeSubfolders?: boolean;
  selected: string[];
  setSelected: (paths: string[]) => void;
};

export const ThumbnailViewer: React.FC<Params> = (params) => {
  const { directoryPath, includeSubfolders, selected, setSelected } =
    params;
  const [search, setSearch] = useState("");

  type Thumbnail = {
    path: string;
    type: "file" | "directory";
    details?: { dimensions: { width: number; height: number } };
  }
  const [thumbnails, setThumbnails] = useState<Array<Thumbnail>>([]);
  const [loading, setLoading] = useState(false);
  const [size, setSize] = useState(0.2 * (maxSize - minSize) + minSize);
  const styles = useStyles();

  const onClick = (e: React.MouseEvent) => {
    const path = (e.currentTarget as HTMLDivElement).dataset.path;
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
  url.searchParams.set("details", JSON.stringify(["dimensions"]));
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
          thumbnailData = thumbnailData.concat(...linesChunk.map((line) => JSON.parse(line)));
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
            const dimensions = thumbnail.details?.dimensions;
            const ratio = (dimensions?.width || 1) / (dimensions?.height || 1);
            return (
              <div
                key={thumbnail.path}
                data-path={thumbnail.path}
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
                <Media
                  path={thumbnail.path}
                  width={100}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
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
