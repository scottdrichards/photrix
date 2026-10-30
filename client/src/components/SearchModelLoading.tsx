import { useEffect, useRef, useState } from "react";
import {
  fetchSearchStatusDetail,
  type SearchSource,
  type SearchSourceStatus,
  type SearchStatusDetail,
} from "../api";
import { logFailure } from "../logFailure";
import css from "./SearchModelLoading.module.css";

const POLL_MS = 1_000;
/** After this long, stop promising results and say something may be wrong. */
const GIVE_UP_MS = 3 * 60_000;

const MODEL_NAMES: Partial<Record<SearchSource, string>> = {
  image: "photo search model",
  audio: "audio search model",
};

const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} s`;

const joinNames = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "search model") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

type Props = {
  /** The failed search's per-source outcome. */
  outcome: SearchSourceStatus;
  /** Re-run the search. Called on its own once every awaited model is ready. */
  onRetry: () => void;
};

/**
 * Feedback #162: the empty grid after a search that came back with nothing
 * because its models were still loading. It used to say only "a search model
 * is still loading" and offer Retry, which read like an excuse. Now it says
 * which model, how long it has been loading against how long the last load
 * took, and runs the search again by itself the moment the model is ready.
 */
export const SearchModelLoading = ({ outcome, onRetry }: Props) => {
  const awaited = (Object.keys(outcome) as SearchSource[]).filter((source) => {
    const result = outcome[source];
    return result?.status === "failed" && result.reason === "loading";
  });
  const otherFailure = (Object.keys(outcome) as SearchSource[]).some((source) => {
    const result = outcome[source];
    return result?.status === "failed" && result.reason !== "loading";
  });

  const [detail, setDetail] = useState<SearchStatusDetail | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const retried = useRef(false);
  // A worker that dies mid-load restarts the server's timer; the user has
  // still been waiting since the search came back, so show the longer of the two.
  const waitingSince = useRef(Date.now());
  const onRetryRef = useRef(onRetry);
  onRetryRef.current = onRetry;
  const awaitedKey = awaited.join(",");

  useEffect(() => {
    retried.current = false;
    waitingSince.current = Date.now();
    setGaveUp(false);
    setDetail(null);
    if (!awaitedKey) return;
    const sources = awaitedKey.split(",") as SearchSource[];
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const giveUp = setTimeout(() => {
      setGaveUp(true);
      controller.abort("gave up");
      clearTimeout(timer);
    }, GIVE_UP_MS);

    const poll = () => {
      fetchSearchStatusDetail(controller.signal)
        .then((next) => {
          if (controller.signal.aborted) return;
          setDetail(next);
          if (!retried.current && sources.every((source) => next.sources[source] === "ready")) {
            retried.current = true;
            onRetryRef.current();
          }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            logFailure("search.status.failed", "Could not read search status")(error);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted && !retried.current) timer = setTimeout(poll, POLL_MS);
        });
    };
    poll();
    return () => {
      controller.abort("disposed");
      clearTimeout(timer);
      clearTimeout(giveUp);
    };
  }, [awaitedKey]);

  const names = joinNames(awaited.map((source) => MODEL_NAMES[source] ?? source));

  if (awaited.length === 0) {
    return (
      <div className={css.panel} role="status">
        <h3>Search didn&apos;t finish: {otherFailure ? "a source failed or was too slow" : "no source answered"}.</h3>
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }

  // The longest-running of the awaited loads stands for all of them.
  const loads = awaited.map((source) => detail?.loads[source] ?? {});
  const serverLoadingForMs = Math.max(0, ...loads.map((load) => load.loadingForMs ?? 0));
  const loadingForMs =
    serverLoadingForMs > 0
      ? Math.max(serverLoadingForMs, Date.now() - waitingSince.current)
      : 0;
  const lastLoadMs = Math.max(0, ...loads.map((load) => load.lastLoadMs ?? 0));
  const states = awaited.map((source) => detail?.sources[source]);
  const notLoading = detail !== null && states.every((state) => state === "cold");

  let progressText: string;
  if (gaveUp) {
    progressText =
      "Still not ready after 3 minutes, so something may be wrong. Server Status shows the search workers.";
  } else if (notLoading) {
    progressText = "It isn\u2019t loading right now. Retry starts it.";
  } else if (loadingForMs > 0) {
    progressText =
      `Loading for ${seconds(loadingForMs)}` +
      (lastLoadMs > 0 ? `; last time it took ${seconds(lastLoadMs)}.` : ".") +
      " Results will appear here when it\u2019s ready.";
  } else {
    progressText = "Results will appear here when it\u2019s ready.";
  }

  const fraction =
    !gaveUp && !notLoading && lastLoadMs > 0 ? Math.min(0.95, loadingForMs / lastLoadMs) : null;

  return (
    <div className={css.panel} role="status">
      <h3>Search is waiting for the {names} to load.</h3>
      <p className={css.detail}>{progressText}</p>
      {fraction !== null && (
        <progress
          className={css.progress}
          max={1}
          value={fraction}
          aria-label={`Loading the ${names}`}
        />
      )}
      <button type="button" onClick={onRetry}>
        Retry now
      </button>
    </div>
  );
};
