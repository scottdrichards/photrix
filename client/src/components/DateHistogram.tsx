import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "../Spinner";
import css from "./DateHistogram.module.css";
import { fetchDateHistogram } from "../api";
import type { DateHistogramBucket } from "../api";
import { useFilter } from "./filter/FilterContext";

type Range = { start: number; end: number } | null;

type DateHistogramProps = {
  label?: string;
};

const CHART_PADDING = { left: 18, right: 18, top: 10, bottom: 22 } as const;

const formatDate = (value: number) =>
  new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

type Grouping = "day" | "month" | "year";

const formatTick = (value: number, grouping: Grouping) => {
  const date = new Date(value);
  if (grouping === "year") {
    return date.toLocaleDateString(undefined, { year: "numeric" });
  }
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
  grouping: Grouping,
  width: number,
  padding: { left: number; right: number },
) => {
  if (!domain) return [] as number[];
  const inner = Math.max(1, width - padding.left - padding.right);
  const maxTicks = Math.max(2, Math.floor(inner / 90));
  if (maxTicks <= 0) return [];

  if (grouping === "year") {
    const years = Math.max(1, new Date(domain.max).getFullYear() - new Date(domain.min).getFullYear());
    const stepChoices = [1, 2, 5, 10, 20, 50];
    const stepYears = stepChoices.find((step) => years / step <= maxTicks) ?? 100;
    const first = new Date(domain.min);
    first.setMonth(0, 1);
    first.setHours(0, 0, 0, 0);
    const ticks: number[] = [];
    const current = new Date(first.getTime());
    while (current.getTime() <= domain.max) {
      ticks.push(current.getTime());
      current.setFullYear(current.getFullYear() + stepYears, 0, 1);
    }
    return ticks;
  }

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

export const DateHistogram = ({ label = "Date range" }: DateHistogramProps) => {
  const { filter, setFilter } = useFilter();
  const {
    includeSubfolders,
    path,
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    dateRange,
    peopleInImageFilter,
  } = filter;
  const value = dateRange;
  const onChange = useCallback(
    (range: Range) => setFilter({ dateRange: range }),
    [setFilter],
  );
  // Read the current selection inside the fetch effect without listing it as a
  // dependency — otherwise every drag would re-trigger a histogram reload.
  const valueRef = useRef(value);
  valueRef.current = value;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(640);
  const height = 140;
  const padding = CHART_PADDING;

  // Target roughly one bar per ~16px so buckets stay readable (~10px+ wide)
  // instead of collapsing into hundreds of slivers over a multi-year library.
  const desiredBuckets = Math.min(
    60,
    Math.max(12, Math.round((width - padding.left - padding.right) / 16)),
  );

  const [buckets, setBuckets] = useState<DateHistogramBucket[]>([]);
  const [minDate, setMinDate] = useState<number | null>(null);
  const [maxDate, setMaxDate] = useState<number | null>(null);
  const [grouping, setGrouping] = useState<Grouping>("month");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragRange, setDragRange] = useState<Range>(null);
  const isDragging = useRef(false);

  const clearSelection = useCallback(() => {
    setDragRange(null);
    onChange(null);
  }, [onChange]);

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
          peopleInImageFilter,
          buckets: desiredBuckets,
          signal: controller.signal,
        });

        if (controller.signal.aborted) {
          return;
        }

        setBuckets(result.buckets);
        setMinDate(result.minDate);
        setMaxDate(result.maxDate);
        setGrouping(result.grouping);

        const current = valueRef.current;
        if (result.minDate !== null && result.maxDate !== null) {
          if (current) {
            const clampedStart = Math.max(
              result.minDate,
              Math.min(current.start, result.maxDate),
            );
            const clampedEnd = Math.max(
              clampedStart,
              Math.min(current.end, result.maxDate),
            );
            if (current.start !== clampedStart || current.end !== clampedEnd) {
              onChange({ start: clampedStart, end: clampedEnd });
            }
          }
        } else if (current) {
          onChange(null);
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return;
        }
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
  }, [
    includeSubfolders,
    path,
    ratingFilter,
    mediaTypeFilter,
    locationBounds,
    peopleInImageFilter,
    desiredBuckets,
    onChange,
  ]);

  const domain = useMemo(() => {
    const min = minDate ?? buckets[0]?.start ?? null;
    const max = maxDate ?? buckets[buckets.length - 1]?.end ?? null;
    if (min === null || max === null || min === max) {
      return null;
    }
    return { min, max, span: max - min };
  }, [buckets, minDate, maxDate]);

  const maxCount = useMemo(
    () => buckets.reduce((m, b) => Math.max(m, b.count), 0),
    [buckets],
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

  const beginDrag = useCallback(
    (event: React.PointerEvent<SVGRectElement>) => {
      if (!domain) return;
      const svg = event.currentTarget.ownerSVGElement;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const startMs = invertX(event.clientX, rect);
      if (startMs === null) return;
      isDragging.current = true;
      // Capture the pointer so touch drags keep delivering move events to this
      // rect even as the finger drifts past the chart edges.
      event.currentTarget.setPointerCapture?.(event.pointerId);
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

  // Snap a raw pointer range to the bucket edges it covers so a selection
  // always aligns to whole bars. A click (start === end) collapses to the
  // single bucket under the pointer.
  const snapToBuckets = useCallback(
    (rawStart: number, rawEnd: number): Range => {
      if (buckets.length === 0) return null;
      const lo = Math.min(rawStart, rawEnd);
      const hi = Math.max(rawStart, rawEnd);
      const bucketAt = (ms: number) =>
        buckets.find((b) => ms >= b.start && ms <= b.end) ??
        (ms < buckets[0].start ? buckets[0] : buckets[buckets.length - 1]);
      const startBucket = bucketAt(lo);
      const endBucket = bucketAt(hi);
      return { start: startBucket.start, end: endBucket.end };
    },
    [buckets],
  );

  const endDrag = useCallback(() => {
    if (!isDragging.current) return;
    isDragging.current = false;
    setDragRange((current) => {
      if (!current) return current;
      const next = snapToBuckets(current.start, current.end);
      onChange(next);
      return next;
    });
  }, [onChange, snapToBuckets]);

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

  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const bucketIndexAt = useCallback(
    (ms: number) => {
      if (buckets.length === 0) return null;
      const idx = buckets.findIndex((b) => ms >= b.start && ms <= b.end);
      if (idx !== -1) return idx;
      return ms < buckets[0].start ? 0 : buckets.length - 1;
    },
    [buckets],
  );

  const updateHover = useCallback(
    (event: React.PointerEvent<SVGRectElement>) => {
      const svg = event.currentTarget.ownerSVGElement;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const pos = invertX(event.clientX, rect);
      if (pos === null) {
        setHoverIndex(null);
        return;
      }
      setHoverIndex(bucketIndexAt(pos));
    },
    [bucketIndexAt, invertX],
  );

  const bars = useMemo(() => {
    if (!domain || maxCount === 0)
      return [] as Array<{
        x: number;
        width: number;
        height: number;
        y: number;
        count: number;
      }>;
    const innerHeight = height - padding.bottom - padding.top;
    return buckets.map((bucket) => {
      const x0 = xFor(bucket.start);
      const x1 = xFor(bucket.end);
      const barW = Math.max(1, x1 - x0 - 1);
      const ratio = bucket.count / maxCount;
      const barH = bucket.count === 0 ? 0 : Math.max(2, innerHeight * ratio);
      const y = height - padding.bottom - barH;
      return { x: x0, width: barW, height: barH, y, count: bucket.count };
    });
  }, [buckets, domain, height, maxCount, padding.bottom, padding.top, xFor]);

  const ticks = useMemo(
    () => buildTicks(domain, grouping, width, padding),
    [domain, grouping, width, padding],
  );

  const filteredTicks = useMemo(() => {
    if (!domain) return ticks;
    const minSpacing = grouping === "day" ? 50 : 70;
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
  }, [domain, grouping, ticks, xFor]);

  const selectionRect = useMemo(() => {
    if (!domain || !activeRange) return null;
    const x0 = xFor(Math.max(activeRange.start, domain.min));
    const x1 = xFor(Math.min(activeRange.end, domain.max));
    const left = Math.min(x0, x1);
    const right = Math.max(x0, x1);
    return { x: left, width: Math.max(0, right - left) };
  }, [activeRange, domain, xFor]);

  const hoverBar =
    hoverIndex !== null && hoverIndex < bars.length ? bars[hoverIndex] : null;

  const hoverTooltip = useMemo(() => {
    if (hoverIndex === null) return null;
    const bucket = buckets[hoverIndex];
    const bar = bars[hoverIndex];
    if (!bucket || !bar) return null;
    const center = bar.x + bar.width / 2;
    const left = Math.min(Math.max(center, 40), width - 40);
    const label =
      bucket.end - bucket.start > 24 * 60 * 60 * 1000 + 1000
        ? `${formatDate(bucket.start)} – ${formatDate(bucket.end)}`
        : formatDate(bucket.start);
    return { left, count: bucket.count, label };
  }, [bars, buckets, hoverIndex, width]);

  const showEmpty = !loading && (buckets.length === 0 || !domain);
  const canClear = Boolean(value);

  return (
    <div className={css.root}>
      <div className={css.header}>
        <small>{label}</small>
        {canClear ? (
          <button className="btn btn-sm btn-subtle" onClick={clearSelection}>
            Clear
          </button>
        ) : null}
      </div>
      <div ref={containerRef} className={css.chartShell}>
        {showEmpty ? (
          <div className={css.overlayText}>No date metadata available</div>
        ) : null}
        {loading ? (
          <div className={css.overlayText}>
            <Spinner label="Loading dates" />
          </div>
        ) : null}
        <svg
          width={width}
          height={height}
          role="presentation"
          style={{ touchAction: "none" }}
        >
          {bars.map((bar, idx) => (
            <rect
              key={idx}
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              style={{ fill: "var(--blue-bg2)" }}
              opacity={hoverIndex === idx ? 1 : 0.9}
              pointerEvents="none"
            />
          ))}
          {filteredTicks.map((t, idx) => {
            const x = xFor(t);
            return (
              <g key={idx} pointerEvents="none">
                <line
                  x1={x}
                  x2={x}
                  y1={height - padding.bottom}
                  y2={height - padding.bottom + 6}
                  style={{ stroke: "var(--stroke2)" }}
                  strokeWidth={1}
                />
                <text
                  x={x}
                  y={height - 4}
                  textAnchor="middle"
                  fontSize={10}
                  style={{ fill: "var(--fg2)" }}
                >
                  {formatTick(t, grouping)}
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
              style={{ fill: "var(--blue-bg2)" }}
              opacity={0.25}
              pointerEvents="none"
            />
          ) : null}
          {/* Interactive overlay sits on top so bars/ticks never swallow
              pointer events; visuals below are all pointerEvents="none". */}
          <rect
            x={0}
            y={0}
            width={width}
            height={height}
            fill="transparent"
            pointerEvents="all"
            style={{ touchAction: "none" }}
            onPointerDown={beginDrag}
            onPointerMove={(event) => {
              updateDrag(event);
              updateHover(event);
            }}
            onPointerUp={endDrag}
            onPointerLeave={() => setHoverIndex(null)}
          />
          {hoverBar ? (
            <g pointerEvents="none">
              <rect
                x={hoverBar.x - 1}
                y={padding.top}
                width={hoverBar.width + 2}
                height={height - padding.top - padding.bottom}
                style={{ fill: "var(--fg2)" }}
                opacity={0.08}
              />
            </g>
          ) : null}
        </svg>
        {hoverTooltip ? (
          <div
            className={css.tooltip}
            style={{ left: hoverTooltip.left }}
            role="presentation"
          >
            <strong>{hoverTooltip.count}</strong>
            <span>{hoverTooltip.label}</span>
          </div>
        ) : null}
      </div>
      <div className={css.labels}>
        <small>{minDate ? formatDate(minDate) : ""}</small>
        <small>{maxDate ? formatDate(maxDate) : ""}</small>
      </div>
      {error ? <small className={css.error}>{error}</small> : null}
    </div>
  );
};
