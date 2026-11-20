import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";
import {
  ArrowCounterclockwise24Regular,
  Dismiss24Regular,
  FullScreenMaximize24Regular,
  Grid24Regular,
  Pause24Filled,
  Play24Filled,
} from "@fluentui/react-icons";
import {
  fetchStory,
  storyImageUrl,
  type StoryDetail,
  type StoryFrame,
  type StorySummary,
} from "../../api/stories";
import { buildFaceCropUrl } from "../../api/people";
import { attempt } from "../../result";
import { logFailure } from "../../logFailure";
import { setViewerThemeColor } from "../../appChrome";
import { cx } from "../../cx";
import { Spinner } from "../../Spinner";
import {
  SLIDE_MS,
  fitFor,
  kenBurns,
  nearestRoutePoint,
  poseTransform,
  projectRoute,
  slidesOf,
  type Slide,
} from "./storyMotion";
import { formatDayRange, formatFrameTime, formatStoryStats } from "./storyFormat";
import css from "./StoryPlayer.module.css";

/** Cross-fade between slides; the Ken Burns move runs on through it. */
const FADE_MS = 1400;
/** A photo that hasn't loaded by now is shown anyway, rather than stalling the story. */
const LOAD_GRACE_MS = 6000;
const CHROME_IDLE_MS = 2500;

type Props = {
  storyId: string;
  /** The card that was clicked, so the title card can show before the detail loads. */
  summary: StorySummary | null;
  onClose: () => void;
  onShowInLibrary: (story: StorySummary) => void;
};

const imageHeight = () =>
  window.innerHeight * window.devicePixelRatio > 1300 ? 2160 : 1080;

const useViewportAspect = () => {
  const [aspect, setAspect] = useState(() => window.innerWidth / window.innerHeight);
  useEffect(() => {
    const update = () => setAspect(window.innerWidth / window.innerHeight);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return aspect;
};

/** Keeps the screen on while a story plays, where the browser allows it. */
const useWakeLock = (active: boolean) => {
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let released = false;
    void attempt(navigator.wakeLock.request("screen")).then((result) => {
      if (!result.ok)
        return logFailure(
          "stories.wakeLock.failed",
          "Couldn't keep the screen on",
        )(result.error);
      if (released) void result.value.release();
      else sentinel = result.value;
    });
    return () => {
      released = true;
      void sentinel?.release();
    };
  }, [active]);
};

const RouteMap = ({
  story,
  frame,
  large,
}: {
  story: StoryDetail;
  frame: StoryFrame | null;
  large?: boolean;
}) => {
  const width = large ? 560 : 180;
  const height = large ? 360 : 120;
  const { points, project } = useMemo(
    () => projectRoute(story.route, width, height, large ? 28 : 14),
    [story.route, width, height, large],
  );
  const path = points
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const here = frame?.lat != null && frame.lon != null ? frame : null;
  const travelled = here
    ? points.slice(0, nearestRoutePoint(story.route, here.lat!, here.lon!) + 1)
    : [];
  const [dotX, dotY] = here ? project(here.lat!, here.lon!) : [0, 0];
  // On the title card, each place is named where it was first photographed.
  const labels = new Map<string, [number, number]>();
  for (const { place, lat, lon } of large ? story.frames : []) {
    if (place && lat !== null && lon !== null && !labels.has(place) && labels.size < 5)
      labels.set(place, project(lat, lon));
  }
  return (
    <svg
      className={large ? css.routeLarge : css.routeMini}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <path className={css.routePath} d={path} pathLength={1} />
      {travelled.length > 1 && (
        <path
          className={css.routeTravelled}
          d={travelled
            .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`)
            .join(" ")}
        />
      )}
      {points.map(([x, y], i) => (
        <circle
          key={i}
          className={css.routeStop}
          cx={x}
          cy={y}
          r={large ? 3.5 : 1.8}
          style={{ animationDelay: `${600 + (3200 * i) / points.length}ms` }}
        />
      ))}
      {[...labels].map(([place, [x, y]], i) => (
        // Set on the side facing the middle, so a label at the edge stays in view.
        <text
          key={place}
          className={css.routeLabel}
          x={x > width / 2 ? x - 12 : x + 12}
          y={y + 5}
          textAnchor={x > width / 2 ? "end" : "start"}
          style={{ animationDelay: `${1400 + i * 500}ms` }}
        >
          {place}
        </text>
      ))}
      {here && (
        <g transform={`translate(${dotX.toFixed(1)} ${dotY.toFixed(1)})`}>
          <circle className={css.routePulse} r={large ? 14 : 9} />
          <circle className={css.routeDot} r={large ? 6 : 4} />
        </g>
      )}
    </svg>
  );
};

const Avatar = ({
  person,
  size,
}: {
  person: StorySummary["people"][number];
  size: number;
}) =>
  person.face ? (
    <img
      className={css.avatar}
      style={{ width: size, height: size }}
      src={buildFaceCropUrl(
        { box: person.face.box, photo: { path: person.face.path } },
        size >= 100 ? 320 : 160,
      )}
      alt=""
    />
  ) : (
    <span
      className={cx(css.avatar, css.avatarInitial)}
      style={{ width: size, height: size }}
    >
      {person.name.slice(0, 1)}
    </span>
  );

type LayerProps = {
  slide: Slide;
  slideIndex: number;
  story: StoryDetail | null;
  summary: StorySummary;
  aspect: number;
  reducedMotion: boolean;
  onReady: (slideIndex: number) => void;
  actions: { replay: () => void; close: () => void; showInLibrary: () => void };
};

/** One slide, full screen. Layers stack and cross-fade; each keeps its own motion running as it fades out. */
const SlideLayer = ({
  slide,
  slideIndex,
  story,
  summary,
  aspect,
  reducedMotion,
  onReady,
  actions,
}: LayerProps) => {
  const ready = useCallback(() => onReady(slideIndex), [onReady, slideIndex]);
  const height = imageHeight();

  if (slide.kind === "photo") {
    const { frame } = slide;
    const fit =
      frame.width && frame.height ? fitFor(frame.width / frame.height, aspect) : "cover";
    const motion = kenBurns(frame.faces, slide.index, fit);
    const style = {
      "--kb-from": poseTransform(motion.from),
      "--kb-to": poseTransform(reducedMotion ? motion.from : motion.to),
      "--kb-ms": `${SLIDE_MS.photo + FADE_MS}ms`,
    } as CSSProperties;
    const names = [...new Set(frame.faces.flatMap(({ name }) => name ?? []))];
    const url = storyImageUrl(frame.path, height);
    return (
      <div className={css.layer}>
        {fit === "contain" && (
          <img className={css.backdrop} src={storyImageUrl(frame.path, 320)} alt="" />
        )}
        <div
          className={cx(css.kenBurns, fit === "contain" ? css.contain : css.cover)}
          style={style}
        >
          <img
            className={css.photo}
            src={url}
            alt={frame.place ?? ""}
            onLoad={ready}
            onError={ready}
          />
        </div>
        <div className={css.scrim} />
        <div className={css.caption}>
          {frame.place && <div className={css.captionPlace}>{frame.place}</div>}
          <div className={css.captionTime}>
            {story && story.dayCount > 1 && (
              <span className={css.captionDay}>Day {frame.day}</span>
            )}
            {formatFrameTime(frame.localTime)}
          </div>
          {names.length > 0 && (
            <div className={css.captionNames}>{names.join(" · ")}</div>
          )}
        </div>
      </div>
    );
  }

  if (slide.kind === "chapter") {
    const { chapter, next } = slide;
    return (
      <div className={cx(css.layer, css.card)}>
        <img
          className={css.cardBackdrop}
          src={storyImageUrl(next.path, 320)}
          alt=""
          onLoad={ready}
          onError={ready}
        />
        <div className={css.chapter}>
          <div className={css.chapterDay}>Day {chapter.day}</div>
          {chapter.place && <div className={css.chapterPlace}>{chapter.place}</div>}
          <div className={css.chapterDate}>
            {new Date(`${chapter.date}T12:00:00`).toLocaleDateString("en-US", {
              weekday: "long",
              month: "long",
              day: "numeric",
            })}
          </div>
        </div>
      </div>
    );
  }

  if (slide.kind === "title") {
    return (
      <div className={cx(css.layer, css.card)}>
        <div
          className={cx(css.kenBurns, css.cover, css.titleCover)}
          style={
            {
              "--kb-from": "scale(1.04)",
              "--kb-to": reducedMotion ? "scale(1.04)" : "scale(1.16)",
              "--kb-ms": `${SLIDE_MS.title + FADE_MS}ms`,
            } as CSSProperties
          }
        >
          <img
            className={css.photo}
            src={storyImageUrl(summary.cover.path, height)}
            alt=""
            onLoad={ready}
            onError={ready}
          />
        </div>
        <div className={css.titleScrim} />
        {story && story.route.length > 1 && (
          <div className={css.titleRoute}>
            <RouteMap story={story} frame={null} large />
          </div>
        )}
        <div className={css.titleBlock}>
          <div className={css.kicker}>{summary.kicker}</div>
          <h2 className={css.title}>{summary.title}</h2>
          <div className={css.titleDates}>
            {formatDayRange(summary.startDay, summary.endDay)}
          </div>
          <div className={css.titleStats}>
            {formatStoryStats(summary, navigator.language)}
          </div>
        </div>
      </div>
    );
  }

  const backdrop = story?.frames.slice(-4) ?? [];
  return (
    <div className={cx(css.layer, css.card, css.endCard)}>
      <div className={css.endMosaic} aria-hidden="true">
        {backdrop.map((frame) => (
          <img key={frame.path} src={storyImageUrl(frame.path, 640)} alt="" />
        ))}
      </div>
      <div className={css.endContent}>
        {summary.people.length > 0 ? (
          <>
            <div className={css.kicker}>Starring</div>
            <div className={css.starring}>
              {summary.people.slice(0, 6).map((person) => (
                <figure key={person.name} className={css.star}>
                  <Avatar person={person} size={96} />
                  <figcaption>{person.name}</figcaption>
                </figure>
              ))}
            </div>
          </>
        ) : (
          <div className={css.kicker}>The end</div>
        )}
        <h2 className={css.endTitle}>{summary.title}</h2>
        <div className={css.titleStats}>
          {formatDayRange(summary.startDay, summary.endDay)} ·{" "}
          {formatStoryStats(summary, navigator.language)}
        </div>
        <div className={css.endActions}>
          <button type="button" className={css.endButton} onClick={actions.replay}>
            <ArrowCounterclockwise24Regular /> Play again
          </button>
          <button type="button" className={css.endButton} onClick={actions.showInLibrary}>
            <Grid24Regular /> See all {summary.photoCount + summary.videoCount}
          </button>
          <button type="button" className={css.endButton} onClick={actions.close}>
            <Dismiss24Regular /> Close
          </button>
        </div>
      </div>
    </div>
  );
};

/**
 * Plays a story full screen: a title card with the route drawing itself,
 * then each highlight with a slow Ken Burns move toward its faces, a chapter
 * card at each new day, a live mini-map of where the photo was taken, and an
 * end card naming who was there. Tap or arrow keys to step, space to pause.
 */
export const StoryPlayer = ({ storyId, summary, onClose, onShowInLibrary }: Props) => {
  const [story, setStory] = useState<StoryDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [index, setIndex] = useState(0);
  const [previous, setPrevious] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [readySlides, setReadySlides] = useState<ReadonlySet<number>>(() => new Set());
  const [chromeVisible, setChromeVisible] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const aspect = useViewportAspect();
  const reducedMotion = useMemo(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    setStory(null);
    setFailed(false);
    void attempt(fetchStory(storyId, controller.signal)).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) setStory(result.value);
      else {
        logFailure("stories.load.failed", "Couldn't load a story")(result.error);
        setFailed(true);
      }
    });
    return () => controller.abort();
  }, [storyId]);

  const shown = story ?? summary;
  const slides = useMemo<Slide[]>(
    () => (story ? slidesOf(story) : [{ kind: "title" }]),
    [story],
  );
  const slide = slides[Math.min(index, slides.length - 1)];

  const goTo = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(slides.length - 1, next));
      if (clamped === index) return;
      setPrevious(index);
      setIndex(clamped);
    },
    [slides.length, index],
  );
  const markReady = useCallback(
    (slideIndex: number) =>
      setReadySlides((set) => (set.has(slideIndex) ? set : new Set(set).add(slideIndex))),
    [],
  );

  // The slide clock. It starts once the slide's image is up (or after a grace
  // period), pauses with the story, and resumes with the time that was left.
  const remainingRef = useRef<number>(SLIDE_MS[slide.kind]);
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    remainingRef.current = SLIDE_MS[slide.kind];
    setGraceOver(false);
    const grace = setTimeout(() => setGraceOver(true), LOAD_GRACE_MS);
    return () => clearTimeout(grace);
  }, [index, slide.kind]);
  const slideReady = readySlides.has(index) || graceOver;
  // The title card waits for the detail too, so it never advances into nothing.
  const canRun =
    slideReady && !paused && Boolean(story) && Number.isFinite(SLIDE_MS[slide.kind]);
  useEffect(() => {
    if (!canRun) return;
    const started = performance.now();
    const timer = setTimeout(() => goTo(index + 1), remainingRef.current);
    return () => {
      clearTimeout(timer);
      remainingRef.current -= performance.now() - started;
    };
  }, [canRun, index, goTo]);

  // The outgoing slide stays mounted under the incoming one until the fade is done.
  useEffect(() => {
    if (previous === null) return;
    const timer = setTimeout(() => setPrevious(null), FADE_MS + 100);
    return () => clearTimeout(timer);
  }, [previous, index]);

  // Fetch the next few photos ahead, so a slow connection doesn't show a blank frame.
  useEffect(() => {
    for (const ahead of slides.slice(index + 1, index + 4)) {
      const path =
        ahead.kind === "photo"
          ? ahead.frame.path
          : ahead.kind === "chapter"
            ? ahead.next.path
            : null;
      if (path) new Image().src = storyImageUrl(path, imageHeight());
    }
  }, [slides, index]);

  const togglePause = useCallback(() => setPaused((value) => !value), []);
  const replay = useCallback(() => {
    setPaused(false);
    goTo(0);
  }, [goTo]);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void attempt(document.exitFullscreen());
    else if (rootRef.current?.requestFullscreen) {
      void attempt(rootRef.current.requestFullscreen()).then((result) => {
        if (!result.ok)
          logFailure(
            "stories.fullscreen.failed",
            "Couldn't go full screen",
          )(result.error);
      });
    }
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.fullscreenElement) onClose();
      else if (event.key === "ArrowRight") goTo(index + 1);
      else if (event.key === "ArrowLeft") goTo(index - 1);
      else if (event.key === " ") {
        event.preventDefault();
        togglePause();
      } else if (event.key === "f") toggleFullscreen();
      else return;
      setChromeVisible(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, goTo, onClose, togglePause, toggleFullscreen]);

  // The controls fade away while the story plays untouched.
  useEffect(() => {
    if (!chromeVisible || paused) return;
    const timer = setTimeout(() => setChromeVisible(false), CHROME_IDLE_MS);
    return () => clearTimeout(timer);
  }, [chromeVisible, paused]);

  useEffect(() => {
    rootRef.current?.focus();
    setViewerThemeColor(true);
    // As the photo viewer does: no page scroll under the story, and no
    // reserved scrollbar gutter showing as a strip down its right edge.
    const root = document.documentElement.style;
    root.overflow = "hidden";
    root.scrollbarGutter = "unset";
    return () => {
      setViewerThemeColor(false);
      root.overflow = "";
      root.scrollbarGutter = "";
    };
  }, []);
  useWakeLock(!paused);

  // A tap on the left third steps back, anywhere else steps on; a swipe does the same.
  const pointerStart = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (event: PointerEvent) => {
    pointerStart.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start || slide.kind === "end") return;
    setChromeVisible(true);
    const dx = event.clientX - start.x;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(event.clientY - start.y))
      goTo(index + (dx < 0 ? 1 : -1));
    else if (Math.abs(dx) < 10)
      goTo(index + (event.clientX < window.innerWidth / 3 ? -1 : 1));
  };

  if (!shown) {
    return (
      <div
        className={css.root}
        role="dialog"
        aria-modal="true"
        aria-label="Story"
        ref={rootRef}
        tabIndex={-1}
      >
        <div className={css.center}>
          {failed ? "This story couldn’t be loaded." : <Spinner label="Loading story" />}
        </div>
        <button
          type="button"
          className={cx(css.iconButton, css.floatingClose)}
          onClick={onClose}
          aria-label="Close story"
        >
          <Dismiss24Regular />
        </button>
      </div>
    );
  }

  const photoFrame = slide.kind === "photo" ? slide.frame : null;
  const layerProps = {
    story,
    summary: shown,
    aspect,
    reducedMotion,
    onReady: markReady,
    actions: { replay, close: onClose, showInLibrary: () => onShowInLibrary(shown) },
  };
  const layers =
    previous !== null && previous !== index && previous < slides.length
      ? [previous, index]
      : [index];

  return (
    <div
      className={css.root}
      role="dialog"
      aria-modal="true"
      aria-label={`Story: ${shown.title}`}
      ref={rootRef}
      tabIndex={-1}
      data-paused={paused || !slideReady || !story ? "true" : "false"}
      data-chrome={chromeVisible ? "visible" : "hidden"}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerMove={(event) => {
        if (event.pointerType === "mouse" && !chromeVisible) setChromeVisible(true);
      }}
    >
      <div className={css.stage}>
        {layers.map((layerIndex) => (
          <div
            key={layerIndex}
            className={cx(css.fadeIn, layerIndex !== index && css.outgoing)}
            data-kind={slides[layerIndex].kind}
          >
            <SlideLayer
              slide={slides[layerIndex]}
              slideIndex={layerIndex}
              {...layerProps}
            />
          </div>
        ))}
      </div>

      {story && photoFrame && story.route.length > 1 && (
        <div className={css.miniMap}>
          <RouteMap story={story} frame={photoFrame} />
        </div>
      )}

      <div
        className={css.chrome}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
      >
        <div className={css.progress} aria-hidden="true">
          {slides.map((candidate, i) => (
            <div
              key={i}
              className={cx(css.segment, candidate.kind !== "photo" && css.segmentCard)}
            >
              <div
                className={cx(
                  css.segmentFill,
                  i < index && css.segmentDone,
                  i === index && css.segmentActive,
                )}
                style={
                  i === index
                    ? ({
                        "--segment-ms": `${Number.isFinite(SLIDE_MS[slide.kind]) ? SLIDE_MS[slide.kind] : 1}ms`,
                      } as CSSProperties)
                    : undefined
                }
              />
            </div>
          ))}
        </div>
        <div className={css.chromeRow}>
          <div className={css.chromeTitle}>
            <span>{shown.title}</span>
            <small>{formatDayRange(shown.startDay, shown.endDay)}</small>
          </div>
          <button
            type="button"
            className={css.iconButton}
            onClick={togglePause}
            aria-label={paused ? "Play" : "Pause"}
          >
            {paused ? <Play24Filled /> : <Pause24Filled />}
          </button>
          {"requestFullscreen" in document.documentElement && (
            <button
              type="button"
              className={css.iconButton}
              onClick={toggleFullscreen}
              aria-label="Full screen"
            >
              <FullScreenMaximize24Regular />
            </button>
          )}
          <button
            type="button"
            className={css.iconButton}
            onClick={onClose}
            aria-label="Close story"
          >
            <Dismiss24Regular />
          </button>
        </div>
      </div>
      {paused && slide.kind !== "end" && (
        <div className={css.pausedBadge} aria-live="polite">
          <Pause24Filled /> Paused
        </div>
      )}
    </div>
  );
};
