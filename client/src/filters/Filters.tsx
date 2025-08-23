import { makeStyles } from "@fluentui/react-components";
import { RatingOptions, useFilter } from "../contexts/filterContext";
import { Keywords } from "./Keywords";
import { MapView } from "../MapView";
import { FolderExplorer } from "../FolderExplorer";
import { useEffect, useRef, useState } from "react";

const useStyles = makeStyles({
  filtersContainer: {
    display: "grid",
    gridTemplateRows: "1fr",
    height: "100%",
    padding: "8px 8px 8px 8px",
    boxSizing: "border-box",
    overflow: "hidden",
    rowGap: 0,
    userSelect: "none"
  },
  panel: {
    overflow: "auto",
    background: "rgba(255,255,255,0.75)",
    backdropFilter: "blur(2px)",
    border: "1px solid #e1dfdd",
    borderRadius: "6px",
    padding: "6px 6px 8px",
    boxSizing: "border-box",
    minHeight: 0,
  },
  // Smaller padding for compact panels (rating)
  compactPanel: {
    padding: "4px 6px 6px"
  },
  mapPanel: {
    padding: 0,
    display: "flex",
    flexDirection: "column",
    minHeight: 0
  },
  folderPanel: {
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0
  },
  resizer: {
    height: "6px",
    cursor: "row-resize",
    background: "linear-gradient(90deg,#edebe9,#f3f2f1)",
    position: "relative",
    '&:after': {
      content: '""',
      position: 'absolute',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%, -50%)',
      width: '32px',
      height: '2px',
      background: '#c8c6c4',
      borderRadius: '2px'
    },
    '&:hover': {
      background: "linear-gradient(90deg,#e1dfdd,#edebe9)"
    }
  },
  dragging: {
    background: "#ffe8b5 !important"
  },
  ratingLabel: {
    display: "block",
    marginBottom: "8px",
    fontSize: "14px",
    fontWeight: "600",
    color: "#323130"
  },
  ratingContainer: {
    display: "flex",
    flexDirection: "column",
    gap: "4px"
  },
  ratingOption: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    padding: "2px 6px",
    borderRadius: "4px",
    cursor: "pointer",
    backgroundColor: "#ffffff",
    border: "1px solid #ddd",
    transition: "background-color 100ms, box-shadow 100ms, border-color 100ms",
    userSelect: "none",
    "&[data-selected='true']": {
      backgroundColor: "#f6e7b8",
      border: "1px solid #d4b032"
    },
    "&:hover": {
      backgroundColor: "#f0f0f0"
    },
    "&:active": {
      backgroundColor: "#ececec"
    }
  },
  ratingNumber: {
    width: "14px",
    fontSize: "11px",
    fontWeight: 600,
    color: "#605e5c"
  },
  starRow: {
    display: "flex",
    alignItems: "center",
    gap: "1px"
  },
  star: {
    cursor: "pointer",
    fontSize: "14px",
    lineHeight: 1,
    transition: "transform 80ms",
    color: "#d2d0ce",
    "&[data-active='true']": {
      color: "#ffc83d"
    },
    "&:hover": {
      transform: "scale(1.1)"
    }
  }
});

export const Filters: React.FC = () => {
  const styles = useStyles();
  const { filter, setFilter } = useFilter();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [heights, setHeights] = useState<number[] | null>(null); // Folder, Keywords, Rating, Map
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const startPosRef = useRef(0);
  const startHeightsRef = useRef<number[]>([]);
  const dividerHeight = 6; // matches resizer style height
  const minPanelHeight = 60;

  // Initialize heights on first layout
  useEffect(() => {
    if (!containerRef.current || heights) return;
    const total = containerRef.current.clientHeight;
    const dividersTotal = dividerHeight * 3; // 4 panels => 3 dividers
    const available = total - dividersTotal;
    // Default distribution (ratios): Folder 0.22, Keywords 0.22, Rating 0.14, Map 0.42
    const initial = [0.22, 0.22, 0.14, 0.42].map(r => Math.max(minPanelHeight, Math.round(available * r)));
    // Adjust if rounding pushes sum over available
    const diff = initial.reduce((a,b)=>a+b,0) - available;
    if (diff !== 0) {
      initial[initial.length - 1] -= diff; // adjust map panel
    }
    setHeights(initial);
  }, [heights]);

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (dragIndex === null || !heights) return;
      const delta = e.clientY - startPosRef.current;
      const newHeights = [...startHeightsRef.current];
      const a = dragIndex;
      const b = dragIndex + 1;
      // Distribute delta between panel a and b
      let newA = newHeights[a] + delta;
      let newB = newHeights[b] - delta;
      if (newA < minPanelHeight) {
        newB -= (minPanelHeight - newA);
        newA = minPanelHeight;
      }
      if (newB < minPanelHeight) {
        newA -= (minPanelHeight - newB);
        newB = minPanelHeight;
      }
      if (newA >= minPanelHeight && newB >= minPanelHeight) {
        newHeights[a] = newA;
        newHeights[b] = newB;
        setHeights(newHeights);
      }
    };
    const handleUp = () => {
      setDragIndex(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    if (dragIndex !== null) {
      window.addEventListener('mousemove', handleMove);
      window.addEventListener('mouseup', handleUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [dragIndex, heights]);

  const startDrag = (index: number) => (e: React.MouseEvent) => {
    if (!heights) return;
    setDragIndex(index);
    startPosRef.current = e.clientY;
    startHeightsRef.current = [...heights];
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  };

  const gridTemplateRows = heights
    ? heights.map(h => `${h}px`).join(` ${dividerHeight}px `)
    : 'auto';

  return (
    <div
      ref={containerRef}
      className={styles.filtersContainer}
      style={{ gridTemplateRows }}
    >
      {/* Folder */}
  <div className={`${styles.panel} ${styles.folderPanel}`}>
        <FolderExplorer />
      </div>
      {/* Resizer 0 */}
      <div
        className={`${styles.resizer} ${dragIndex===0 ? styles.dragging : ''}`}
        onMouseDown={startDrag(0)}
      />
      {/* Keywords */}
      <div className={styles.panel}>
        <Keywords />
      </div>
      {/* Resizer 1 */}
      <div
        className={`${styles.resizer} ${dragIndex===1 ? styles.dragging : ''}`}
        onMouseDown={startDrag(1)}
      />
      {/* Rating */}
      <div className={`${styles.panel} ${styles.compactPanel}`}>
        <div className={styles.ratingLabel}>Rating</div>
        <div className={styles.ratingContainer}>
          {RatingOptions.map(rating => {
            const selected = filter.rating?.includes(rating) ?? false;
            return (
              <div
                key={rating}
                className={styles.ratingOption}
                data-selected={selected || undefined}
                onClick={() => {
                  setFilter({
                    ...filter,
                    rating: selected
                      ? filter.rating!.filter(r => r !== rating)
                      : (filter.rating ? [...filter.rating, rating] : [rating])
                  });
                }}
              >
                <span className={styles.ratingNumber}>{rating}</span>
                <div className={styles.starRow}>
                  {[1,2,3,4,5].map(starIndex => (
                    <span
                      key={starIndex}
                      className={styles.star}
                      data-active={starIndex <= Number(rating) || undefined}
                    >
                      ★
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {/* Resizer 2 */}
      <div
        className={`${styles.resizer} ${dragIndex===2 ? styles.dragging : ''}`}
        onMouseDown={startDrag(2)}
      />
      {/* Map */}
      <div className={`${styles.panel} ${styles.mapPanel}`}>
        <MapView />
      </div>
    </div>
  );
};
