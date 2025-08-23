import "./App.css";
import { useStyles } from "./App.styles";
import { Preview } from "./Preview";
import { ThumbnailViewer } from "./ThumbnailViewer";
import { FilterProvider } from "./contexts/filterContext";
import { SelectedProvider } from "./contexts/selectedContext";
import { Filters } from "./filters/Filters";
import { useEffect, useRef, useState } from 'react';

const App = () => {

  const styles = useStyles();
  // widths in pixels; initialized later after first render to allow layout measurement
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [widths, setWidths] = useState<number[] | null>(null); // filters, thumbs, preview
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const startPosRef = useRef(0);
  const startWidthsRef = useRef<number[]>([]);
  const dividerWidth = 6;
  const minPanelWidth = 140; // for compact filters, rest can grow

  // Initialize widths (ratios: filters 0.22, thumbs 0.46, preview 0.32)
  useEffect(() => {
    if (!containerRef.current || widths) return;
    const total = containerRef.current.clientWidth;
    const dividersTotal = dividerWidth * 2;
    const available = total - dividersTotal;
    const initial = [0.22, 0.46, 0.32].map(r => Math.max(minPanelWidth, Math.round(available * r)));
    const diff = initial.reduce((a,b)=>a+b,0) - available;
    if (diff !== 0) initial[initial.length - 1] -= diff;
    setWidths(initial);
  }, [widths]);

  useEffect(() => {
    const handleMove = (e: MouseEvent) => {
      if (dragIndex === null || !widths) return;
      const delta = e.clientX - startPosRef.current;
      const newWidths = [...startWidthsRef.current];
      const a = dragIndex;
      const b = dragIndex + 1;
      let newA = newWidths[a] + delta;
      let newB = newWidths[b] - delta;
      if (newA < minPanelWidth) { newB -= (minPanelWidth - newA); newA = minPanelWidth; }
      if (newB < minPanelWidth) { newA -= (minPanelWidth - newB); newB = minPanelWidth; }
      if (newA >= minPanelWidth && newB >= minPanelWidth) {
        newWidths[a] = newA;
        newWidths[b] = newB;
        setWidths(newWidths);
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
  }, [dragIndex, widths]);

  const startDrag = (index: number) => (e: React.MouseEvent) => {
    if (!widths) return;
    setDragIndex(index);
    startPosRef.current = e.clientX;
    startWidthsRef.current = [...widths];
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const gridTemplateColumns = widths
    ? widths.map(w => `${w}px`).join(` ${dividerWidth}px `)
    : 'auto';

  return (
    <div
      ref={containerRef}
      className={styles.root}
      style={{
        gridTemplateColumns,
        backgroundImage: "linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)"
      }}
    >
      <div className={styles.panelWrapper}>
        <Filters />
      </div>
      <div
        className={`${styles.divider} ${dragIndex===0 ? styles.dragging : ''}`}
        onMouseDown={startDrag(0)}
      />
      <div className={styles.panelWrapper}>
        <ThumbnailViewer />
      </div>
      <div
        className={`${styles.divider} ${dragIndex===1 ? styles.dragging : ''}`}
        onMouseDown={startDrag(1)}
      />
      <div className={styles.panelWrapper}>
        <Preview />
      </div>
    </div>
  );
};

export default () => (
  <SelectedProvider>
    <FilterProvider>
      <App />
    </FilterProvider>
  </SelectedProvider>
);
