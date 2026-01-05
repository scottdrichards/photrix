import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Caption1, Spinner, makeStyles, tokens } from "@fluentui/react-components";
import { fetchDateHistogram } from "../api";
import type { DateHistogramBucket, GeoBounds } from "../api";

type Range = { start: number; end: number } | null;

type DateHistogramProps = {
  label?: string;
  value: Range;
  onChange: (range: Range) => void;
  includeSubfolders: boolean;
  path: string;
  ratingFilter?: { rating: number; atLeast: boolean } | null;
  mediaTypeFilter: "all" | "photo" | "video" | "other";
  locationBounds?: GeoBounds | null;
  refreshToken?: number;
};

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingHorizontalXS,
    minWidth: "320px",
    width: "100%",
    maxWidth: "680px",
  },
  chartShell: {
    position: "relative",
    width: "100%",
    height: "160px",
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    padding: tokens.spacingHorizontalXS,
    boxSizing: "border-box",
  },
  overlayText: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: tokens.colorNeutralForeground2,
  },
  labels: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
    color: tokens.colorNeutralForeground2,
  },
  error: {
    color: tokens.colorPaletteRedForeground3,
  },
});

const formatDate = (value: number) =>
  new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

const formatTick = (value: number, grouping: "day" | "month") => {
  const date = new Date(value);
  if (grouping === "month") {
    return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

const diffMonths = (start: number, end: number) => {
  const a = new Date(start);
  const b = new Date(end);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
};

const buildTicks = (
  domain: { min: number; max: number; span: number } | null,
  grouping: "day" | "month",
  width: number,
  padding: { left: number; right: number },
) => {
  if (!domain) return [] as number[];
  const inner = Math.max(1, width - padding.left - padding.right);
  const maxTicks = Math.max(2, Math.floor(inner / 90));
  if (maxTicks <= 0) return [];

  if (grouping === "month") {
    const months = Math.max(1, diffMonths(domain.min, domain.max));
    const stepChoices = [1, 2, 3, 6, 12];
    const stepMonths = stepChoices.find((step) => months / step <= maxTicks) ?? 12;
    const first = new Date(domain.min);
    first.setDate(1);
    first.setHours(0, 0, 0, 0);
    const ticks: number[] = [];
    const current = new Date(first.getTime());
    while (current.getTime() <= domain.max) {
      ticks.push(current.getTime());
      current.setMonth(current.getMonth() + stepMonths, 1);
    }
    return ticks;
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const spanDays = domain.span / dayMs;
  const stepChoices = [1, 2, 3, 5, 7, 14, 21, 30];
  const stepDays = stepChoices.find((step) => spanDays / step <= maxTicks) ?? 30;
  const first = new Date(domain.min);
  first.setHours(0, 0, 0, 0);
  const ticks: number[] = [];
  const current = new Date(first.getTime());
  while (current.getTime() <= domain.max) {
    ticks.push(current.getTime());
    current.setDate(current.getDate() + stepDays);
  }
  return ticks;
};

export const DateHistogram = ({
  label = "Date range",
  value,
  onChange,
  includeSubfolders,
  path,
  ratingFilter,
  mediaTypeFilter,
  locationBounds,
  refreshToken,
}: DateHistogramProps) => {
  const styles = useStyles();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(640);
  const height = 140;
  const padding = { left: 18, right: 18, top: 10, bottom: 22 };
  const DAY_MS = 24 * 60 * 60 * 1000;

  const [buckets, setBuckets] = useState<DateHistogramBucket[]>([]);
  const [minDate, setMinDate] = useState<number | null>(null);
  const [maxDate, setMaxDate] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width) {
          setWidth(entry.contentRect.width);
        }
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const loadHistogram = async () => {
      try {
        const result = await fetchDateHistogram({
          includeSubfolders,
          path,
          ratingFilter,
          mediaTypeFilter,
          locationBounds,
          dateRange: null,
          signal: controller.signal,
        });

        if (controller.signal.aborted) {
          return;
        }

        setBuckets(result.buckets);
        setMinDate(result.minDate);
        setMaxDate(result.maxDate);

        if (result.minDate !== null && result.maxDate !== null) {
          const clampedStart = Math.max(result.minDate, Math.min(value?.start ?? result.minDate, result.maxDate));
          const clampedEnd = Math.max(clampedStart, Math.min(value?.end ?? result.maxDate, result.maxDate));
          if (!value || value.start !== clampedStart || value.end !== clampedEnd) {
            onChange({ start: clampedStart, end: clampedEnd });
          }
        } else if (value) {
          onChange(null);
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return;
        }
        console.error(err);
        setError((err as Error).message ?? "Failed to load date histogram");
        setBuckets([]);
        setMinDate(null);
        setMaxDate(null);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    };

    void loadHistogram();

    return () => controller.abort();
  }, [includeSubfolders, path, ratingFilter, mediaTypeFilter, locationBounds, refreshToken]);

  const domain = useMemo(() => {
    const min = minDate ?? (buckets[0]?.start ?? null);
    const max = maxDate ?? (buckets[buckets.length - 1]?.end ?? null);
    if (min === null || max === null || min === max) {
      return null;
    }
    return { min, max, span: max - min };
  }, [buckets, minDate, maxDate]);

  const maxCount = useMemo(
    () => buckets.reduce((m, b) => Math.max(m, b.count), 0),
    [buckets],
  );

  const bucketSpan = useMemo(() => (buckets[0] ? buckets[0].end - buckets[0].start : 0), [buckets]);
  const inferredGrouping: "day" | "month" = useMemo(
    () => (bucketSpan > 28 * DAY_MS ? "month" : "day"),
    [DAY_MS, bucketSpan],
  );

  const xFor = useCallback(
    (ms: number) => {
      if (!domain) return padding.left;
      const inner = Math.max(1, width - padding.left - padding.right);
      return padding.left + ((ms - domain.min) / domain.span) * inner;
    },
    [domain, width, padding.left, padding.right],
  );

  const clampToDomain = useCallback(
    (ms: number) => {
      if (!domain) return ms;
      return Math.min(Math.max(ms, domain.min), domain.max);
    },
    [domain],
  );

  const invertX = useCallback(
    (clientX: number, svgRect: DOMRect) => {
      if (!domain) return null;
      const inner = Math.max(1, width - padding.left - padding.right);
      const localX = clientX - svgRect.left - padding.left;
      const ratio = Math.min(1, Math.max(0, localX / inner));
      return domain.min + ratio * domain.span;
    },
    [domain, padding.left, padding.right, width],
  );

  const [dragRange, setDragRange] = useState<Range>(null);
  const isDragging = useRef(false);

  const beginDrag = useCallback(
    (event: React.PointerEvent<SVGRectElement>) => {
      if (!domain) return;
      const svg = event.currentTarget.ownerSVGElement;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const startMs = invertX(event.clientX, rect);
      if (startMs === null) return;
      isDragging.current = true;
      const clamped = clampToDomain(startMs);
      setDragRange({ start: clamped, end: clamped });
    },
    [clampToDomain, domain, invertX],
  );

  const updateDrag = useCallback(
    (event: React.PointerEvent<SVGRectElement>) => {
      if (!isDragging.current || !domain) return;
      const svg = event.currentTarget.ownerSVGElement;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const pos = invertX(event.clientX, rect);
      if (pos === null) return;
      setDragRange((current) => {
        const anchor = current?.start ?? pos;
        const clampedPos = clampToDomain(pos);
        return { start: anchor, end: clampedPos };
      });
    },
    [clampToDomain, domain, invertX],
  );

  const endDrag = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;
    setDragRange((current) => {
      if (!current) return current;
      const start = Math.min(current.start, current.end);
      const end = Math.max(current.start, current.end);
      const next = start === end ? null : { start, end };
      onChange(next);
      return next;
    });
  }, [onChange]);

  useEffect(() => {
    const handleUp = () => {
      if (isDragging.current) {
        endDrag();
      }
    };
    window.addEventListener("pointerup", handleUp);
    return () => window.removeEventListener("pointerup", handleUp);
  }, [endDrag]);

  const activeRange = dragRange ?? value;

  const bars = useMemo(() => {
    if (!domain || maxCount === 0) return [] as Array<{ x: number; width: number; height: number }>;
    const innerHeight = height - padding.bottom - padding.top;
    return buckets.map((bucket) => {
      const x0 = xFor(bucket.start);
      const x1 = xFor(bucket.end);
      const barW = Math.max(1, x1 - x0 - 1);
      const ratio = bucket.count / maxCount;
      const barH = Math.max(2, innerHeight * ratio);
      const y = height - padding.bottom - barH;
      return { x: x0, width: barW, height: barH, y, count: bucket.count };
    });
  }, [buckets, domain, height, maxCount, padding.bottom, padding.top, xFor]);

  const ticks = useMemo(
    () => buildTicks(domain, inferredGrouping, width, padding),
    [domain, inferredGrouping, width, padding],
  );

  const filteredTicks = useMemo(() => {
    if (!domain) return ticks;
    const minSpacing = inferredGrouping === "day" ? 50 : 70;
    const accepted: number[] = [];
    let lastX = -Infinity;
    for (const tick of ticks) {
      const x = xFor(tick);
      if (x - lastX >= minSpacing) {
        accepted.push(tick);
        lastX = x;
      }
    }
    return accepted;
  }, [domain, inferredGrouping, ticks, xFor]);

  const selectionRect = useMemo(() => {
    if (!domain || !activeRange) return null;
    const x0 = xFor(Math.max(activeRange.start, domain.min));
    const x1 = xFor(Math.min(activeRange.end, domain.max));
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    return { x: left, width: Math.max(0, right - left) };
  }, [activeRange, domain, xFor]);

  const showEmpty = !loading && (buckets.length === 0 || !domain);

  return (
    <div className={styles.root}>
      <Caption1>{label}</Caption1>
      <div ref={containerRef} className={styles.chartShell}>
        {showEmpty ? (
          <div className={styles.overlayText}>No date metadata available</div>
        ) : null}
        {loading ? (
          <div className={styles.overlayText}>
            <Spinner label="Loading dates" />
          </div>
        ) : null}
        <svg width={width} height={height} role="presentation">
          <rect
            x={0}
            y={0}
            width={width}
            height={height}
            fill="transparent"
            pointerEvents="all"
            onPointerDown={beginDrag}
            onPointerMove={updateDrag}
          />
          {bars.map((bar, idx) => (
            <rect
              key={idx}
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              fill={tokens.colorPaletteBlueBackground2}
              opacity={0.9}
            />
          ))}
          {filteredTicks.map((t, idx) => {
            const x = xFor(t);
            return (
              <g key={idx}>
                <line
                  x1={x}
                  x2={x}
                  y1={height - padding.bottom}
                  y2={height - padding.bottom + 6}
                  stroke={tokens.colorNeutralStroke2}
                  strokeWidth={1}
                />
                <text
                  x={x}
                  y={height - 4}
                  textAnchor="middle"
                  fontSize={10}
                  fill={tokens.colorNeutralForeground2}
                >
                  {formatTick(t, inferredGrouping)}
                </text>
              </g>
            );
          })}
          {selectionRect ? (
            <rect
              x={selectionRect.x}
              y={padding.top}
              width={selectionRect.width}
              height={height - padding.top - padding.bottom}
              fill={tokens.colorPaletteBlueBackground3}
              opacity={0.25}
              pointerEvents="none"
            />
          ) : null}
        </svg>
      </div>
      <div className={styles.labels}>
        <Caption1>{minDate ? formatDate(minDate) : ""}</Caption1>
        <Caption1>{maxDate ? formatDate(maxDate) : ""}</Caption1>
      </div>
      {error ? <Caption1 className={styles.error}>{error}</Caption1> : null}
    </div>
  );
};
