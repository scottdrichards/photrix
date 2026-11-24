import { CommentAddRegular, Info24Regular, Person24Regular } from "@fluentui/react-icons";
import css from "./App.module.css";
import { ThemeToggle } from "./components/account/ThemeToggle";
import { Filter } from "./components/filter/Filter";
import { SearchBar } from "./components/search/SearchBar";
import { Wordmark } from "./components/Wordmark";
import { ShareButton } from "./ShareButton";
import type { Theme } from "./theme";

const numberFormatter = new Intl.NumberFormat();

type AppHeaderProps = {
  sharedView: boolean;
  /** A signed-in owner is viewing their own share link. */
  ownsAccountSession: boolean;
  viewDescription: string | null;
  resultCount: number | null;
  resultCountIsLowerBound: boolean;
  theme: Theme;
  followsSystem: boolean;
  onThemeToggle: () => void;
  onOpenSuggestion: () => void;
  onOpenAccount: () => void;
  onOpenStatus: () => void;
};

/** The brand row (title, tagline, actions) and the search row under it. */
export const AppHeader = ({
  sharedView,
  ownsAccountSession,
  viewDescription,
  resultCount,
  resultCountIsLowerBound,
  theme,
  followsSystem,
  onThemeToggle,
  onOpenSuggestion,
  onOpenAccount,
  onOpenStatus,
}: AppHeaderProps) => (
  <header className={css.header}>
    <div className={css.title}>
      <h2>
        {sharedView ? <Wordmark /> : <a className={css.homeLink} href="/"><Wordmark /></a>}
      </h2>
      <small>
        {sharedView ? (
          "Shared view"
        ) : viewDescription ? (
          // Feedback #85/#103: fold the current view's generated
          // description into the sentence itself ("...of your trip
          // to Mexico") rather than appending it after a period,
          // which read as two unrelated fragments ("photos. ...trip
          // to Mexico"). Feedback #107: the generated half reads as
          // plain static copy otherwise, so it's set off in its own
          // span (same brand-color treatment as the AI-search
          // chips) to signal "the app said this, not us".
          <>
            A better way to view{" "}
            {resultCount != null && (
              <>
                <span className={css.resultCount}>
                  {numberFormatter.format(resultCount)}{resultCountIsLowerBound ? "+" : ""}
                </span>{" "}
                photo{resultCount === 1 ? "" : "s"}{" "}
              </>
            )}
            of <span className={css.taglineGenerated}>{viewDescription}</span>
          </>
        ) : resultCount != null ? (
          <>
            A better way to view{" "}
            <span className={css.resultCount}>
              {numberFormatter.format(resultCount)}{resultCountIsLowerBound ? "+" : ""}
            </span>{" "}
            photo{resultCount === 1 ? "" : "s"}.
          </>
        ) : (
          "A better way to view photos."
        )}
      </small>
    </div>

    <div className={css.headerActions}>
      {/* A shared link has no Account panel, so the toggle stays here. */}
      {sharedView && (
        <ThemeToggle
          theme={theme}
          followsSystem={followsSystem}
          onToggle={onThemeToggle}
          className={css.headerThemeToggle}
        />
      )}
      <ShareButton />
      {/* Global entry point, deliberately rendered in every view
          including a shared link — the previous entry point was a
          Ctrl/Cmd+P keyboard shortcut explicitly disabled in shared
          view, so shared-link visitors had no way at all to leave
          feedback (feedback #99). */}
      <button
        title="Send a comment or suggestion"
        className="btn btn-subtle"
        onClick={onOpenSuggestion}
      >
        <CommentAddRegular fontSize={20} />
        <span className={css.btnLabel}>Comments</span>
      </button>
      {sharedView && ownsAccountSession && (
        // A signed-in owner viewing their own share link is not trapped in it:
        // the account session is still there, and dropping the ?token= URL
        // restores the full library. A full navigation (not pushState) is
        // deliberate — share mode is read once at module load.
        <a className="btn btn-subtle" href="/" title="Return to your full library">
          <Person24Regular fontSize={20} />
          <span className={css.btnLabel}>My library</span>
        </a>
      )}
      {!sharedView && (
        <>
          <button
            title="Account"
            className="btn btn-subtle"
            onClick={onOpenAccount}
          >
            <Person24Regular fontSize={20} />
            <span className={css.btnLabel}>Account</span>
          </button>
          <button
            title="Server Status"
            className="btn btn-subtle"
            onClick={onOpenStatus}
          >
            <Info24Regular fontSize={20} />
            <span className={css.btnLabel}>Status</span>
          </button>
        </>
      )}
    </div>

    {/* Search and filters get their own row at every width, so the
        brand/utility row above never has to wrap around them. */}
    <div className={css.searchRow}>
      <SearchBar />
      <div className={css.filterSlot}>
        <Filter />
      </div>
    </div>
  </header>
);
