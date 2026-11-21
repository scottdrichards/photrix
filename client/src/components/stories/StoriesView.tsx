import { useEffect, useState, type MouseEvent } from "react";
import { Play24Filled, Sparkle24Regular } from "@fluentui/react-icons";
import {
  fetchStories,
  StoriesForbiddenError,
  storyImageUrl,
  type StorySummary,
} from "../../api/stories";
import { buildFaceCropUrl } from "../../api/people";
import { attempt } from "../../result";
import { logFailure } from "../../logFailure";
import { cx } from "../../cx";
import { Spinner } from "../../Spinner";
import { TopRailPortal } from "../TopRailPortal";
import { ViewToggle } from "../ViewToggle";
import type { ViewMode } from "../../filterUrlState";
import { StoryPlayer } from "./StoryPlayer";
import { formatDayRange, formatStoryStats } from "./storyFormat";
import css from "./StoriesView.module.css";

type Props = {
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  /** The story playing, from the URL; null when none is. */
  storyId: string | null;
  onOpenStory: (id: string | null) => void;
  onShowInLibrary: (story: StorySummary) => void;
};

type Load =
  | { state: "loading" }
  | { state: "ready"; stories: StorySummary[] }
  | { state: "forbidden" }
  | { state: "failed" };

const People = ({ story }: { story: StorySummary }) =>
  story.people.length > 0 && (
    <div className={css.people}>
      <div className={css.faces}>
        {story.people
          .slice(0, 4)
          .map((person) =>
            person.face ? (
              <img
                key={person.name}
                className={css.face}
                src={buildFaceCropUrl(
                  { box: person.face.box, photo: { path: person.face.path } },
                  160,
                )}
                alt=""
                loading="lazy"
              />
            ) : null,
          )}
      </div>
      <span className={css.names}>
        {story.people
          .slice(0, 3)
          .map(({ name }) => name)
          .join(", ")}
        {story.people.length > 3 ? ` +${story.people.length - 3}` : ""}
      </span>
    </div>
  );

const StoryCard = ({
  story,
  featured,
  onOpen,
}: {
  story: StorySummary;
  featured?: boolean;
  onOpen: (id: string) => void;
}) => {
  const open = (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    onOpen(story.id);
  };
  return (
    <a
      className={cx(css.card, featured && css.featured)}
      href={`?view=stories&story=${encodeURIComponent(story.id)}`}
      onClick={open}
      aria-label={`Play story: ${story.title}, ${formatDayRange(story.startDay, story.endDay)}`}
    >
      <div className={css.media}>
        <img
          className={css.cover}
          src={storyImageUrl(story.cover.path, featured ? 1080 : 640)}
          alt=""
          loading={featured ? "eager" : "lazy"}
        />
        {story.collage.length > 0 && (
          <div className={css.collage} aria-hidden="true">
            {story.collage.map((path) => (
              <img key={path} src={storyImageUrl(path, 320)} alt="" loading="lazy" />
            ))}
          </div>
        )}
        <span className={css.play} aria-hidden="true">
          <Play24Filled /> Play
        </span>
      </div>
      <div className={css.body}>
        <span className={css.kicker}>{story.kicker}</span>
        <h3 className={css.title}>{story.title}</h3>
        <p className={css.dates}>{formatDayRange(story.startDay, story.endDay)}</p>
        <p className={css.stats}>{formatStoryStats(story, navigator.language)}</p>
        <People story={story} />
      </div>
    </a>
  );
};

/**
 * Stories: the trips and big days the server found in the library, newest
 * first, the latest one featured. Each card plays a cinematic recap.
 */
export const StoriesView = ({
  view,
  onViewChange,
  storyId,
  onOpenStory,
  onShowInLibrary,
}: Props) => {
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    void attempt(fetchStories(controller.signal)).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) return setLoad({ state: "ready", stories: result.value });
      if (result.error instanceof StoriesForbiddenError)
        return setLoad({ state: "forbidden" });
      logFailure("stories.list.failed", "Couldn't load stories")(result.error);
      setLoad({ state: "failed" });
    });
    return () => controller.abort();
  }, []);

  const stories = load.state === "ready" ? load.stories : [];
  const [featured, ...rest] = stories;
  const years = new Map<string, StorySummary[]>();
  for (const story of rest)
    years.set(story.startDay.slice(0, 4), [
      ...(years.get(story.startDay.slice(0, 4)) ?? []),
      story,
    ]);
  const playing = storyId ? (stories.find(({ id }) => id === storyId) ?? null) : null;

  return (
    <section className={css.view}>
      <TopRailPortal>
        <ViewToggle view={view} onViewChange={onViewChange} />
      </TopRailPortal>

      <header className={css.header}>
        <h2>
          <Sparkle24Regular /> Stories
        </h2>
        <p>
          Trips and big days, found in your library by when and where the photos were
          taken, and told as short films.
        </p>
      </header>

      {load.state === "loading" && (
        <div className={css.message}>
          <Spinner label="Finding your stories" />
        </div>
      )}
      {load.state === "failed" && (
        <div className={css.message}>
          Stories couldn’t be loaded. Try again in a moment.
        </div>
      )}
      {load.state === "forbidden" && (
        <div className={css.message}>
          Stories draw on the whole library, so they aren’t part of a shared link.
        </div>
      )}
      {load.state === "ready" && stories.length === 0 && (
        <div className={css.message}>
          <strong>No stories yet.</strong> They appear once photos carry dates and GPS:
          runs of days away from home, and days at home with far more photos than usual.
        </div>
      )}

      {featured && <StoryCard story={featured} featured onOpen={onOpenStory} />}
      {[...years].map(([year, yearStories]) => (
        <div key={year} className={css.year}>
          <h3 className={css.yearHeading}>{year}</h3>
          <div className={css.grid}>
            {yearStories.map((story) => (
              <StoryCard key={story.id} story={story} onOpen={onOpenStory} />
            ))}
          </div>
        </div>
      ))}

      {storyId && (load.state !== "loading" || playing) && (
        <StoryPlayer
          storyId={storyId}
          summary={playing}
          onClose={() => onOpenStory(null)}
          onShowInLibrary={onShowInLibrary}
        />
      )}
    </section>
  );
};
