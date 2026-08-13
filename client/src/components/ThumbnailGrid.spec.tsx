import { act, render, screen, waitFor } from "@testing-library/react";
import type { MomentClusterDetail, PhotoItem } from "../api";
import { FilterProvider } from "./filter/FilterContext";
import { SelectionProvider } from "./selection/SelectionContext";
import { ThumbnailGrid } from "./ThumbnailGrid";
// Real CSS module (not mocked) so tests can assert against the same
// generated class names ThumbnailGrid itself applies to an inline-unstacked
// cluster's members (css.clusterMember + the tight/round-corner modifiers).
import gridCss from "./ThumbnailGrid.module.css";

const fetchPhotosMock = vi.fn();
const fetchMomentClusterDetailMock = vi.fn<(clusterId: string) => Promise<MomentClusterDetail | null>>();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    fetchPhotos: (...args: unknown[]) => fetchPhotosMock(...args),
    fetchMomentClusterDetail: (...args: [string]) => fetchMomentClusterDetailMock(...args),
  };
});

const makePhoto = (path: string): PhotoItem => ({
  path,
  name: path,
  mediaType: "photo",
  originalUrl: path,
  thumbnailUrl: path,
  previewUrl: path,
  fullUrl: path,
});

vi.mock("./ThumbnailTile", () => ({
  ThumbnailTile: ({
    photo,
    stackCount,
    restackCount,
    onToggleStack,
    onOpenStackActions,
    className,
    viewTransitionName,
  }: {
    photo: PhotoItem;
    stackCount?: number;
    restackCount?: number;
    onToggleStack?: () => void;
    onOpenStackActions?: () => void;
    className?: string;
    viewTransitionName?: string;
  }) => (
    <div data-testid="tile" className={className} data-view-transition-name={viewTransitionName}>
      {photo.path}
      {stackCount && stackCount > 1 ? (
        <button data-testid={`toggle-stack-${photo.path}`} onClick={onToggleStack}>
          {stackCount}
        </button>
      ) : null}
      {restackCount !== undefined ? (
        <button data-testid={`restack-${photo.path}`} onClick={onToggleStack}>
          restack {restackCount}
        </button>
      ) : null}
      {onOpenStackActions ? (
        <button data-testid={`stack-actions-${photo.path}`} onClick={onOpenStackActions}>
          more
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock("./PhotoStackModal", () => ({
  PhotoStackModal: ({ clusterId }: { clusterId: string | null }) =>
    clusterId ? <div data-testid="stack-modal">{clusterId}</div> : null,
}));

type MockObserver = {
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  trigger: (isIntersecting: boolean) => void;
};

const observers: MockObserver[] = [];

beforeAll(() => {
  class FakeIntersectionObserver {
    private callback: IntersectionObserverCallback;
    // A disconnected observer stops delivering, which the real thing guarantees
    // and the grid relies on to stop a single sentinel from advancing the page
    // twice.
    private live = true;

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
      const mockObserver: MockObserver = {
        observe: vi.fn(),
        disconnect: vi.fn(),
        trigger: (isIntersecting: boolean) => {
          if (!this.live) return;
          this.callback(
            [
              {
                isIntersecting,
              } as IntersectionObserverEntry,
            ],
            this as unknown as IntersectionObserver,
          );
        },
      };
      observers.push(mockObserver);
    }

    observe = vi.fn();
    disconnect = vi.fn(() => {
      this.live = false;
    });
  }

  // @ts-expect-error test override
  globalThis.IntersectionObserver = FakeIntersectionObserver;
});

const renderGrid = () =>
  render(
    <FilterProvider>
      <SelectionProvider>
        <ThumbnailGrid view="library" onViewChange={() => {}} />
      </SelectionProvider>
    </FilterProvider>,
  );

describe("ThumbnailGrid", () => {
  beforeEach(() => {
    fetchPhotosMock.mockReset();
    fetchMomentClusterDetailMock.mockReset();
    observers.length = 0;
  });

  it("renders initial photos and then loads additional page with dedupe", async () => {
    fetchPhotosMock
      .mockResolvedValueOnce({
        items: [
          {
            path: "a/1.jpg",
            name: "1.jpg",
            mediaType: "photo",
            originalUrl: "u1",
            thumbnailUrl: "u1",
            previewUrl: "u1",
            fullUrl: "u1",
          },
        ],
        total: 3,
        page: 0,
        pageSize: 200,
      })
      .mockResolvedValueOnce({
        items: [
          {
            path: "a/1.jpg",
            name: "1.jpg",
            mediaType: "photo",
            originalUrl: "u1",
            thumbnailUrl: "u1",
            previewUrl: "u1",
            fullUrl: "u1",
          },
          {
            path: "a/2.jpg",
            name: "2.jpg",
            mediaType: "photo",
            originalUrl: "u2",
            thumbnailUrl: "u2",
            previewUrl: "u2",
            fullUrl: "u2",
          },
        ],
        total: 3,
        page: 1,
        pageSize: 200,
      });

    renderGrid();

    await waitFor(() => {
      expect(fetchPhotosMock).toHaveBeenCalledTimes(1);
      expect(screen.getAllByTestId("tile")).toHaveLength(1);
      expect(screen.getByText("a/1.jpg")).toBeInTheDocument();
      expect(screen.getByText("3 results")).toBeInTheDocument();
      expect(observers.length).toBeGreaterThan(0);
    });

    await act(async () => {
      observers.forEach((observer) => observer.trigger(true));
    });

    await waitFor(() => {
      expect(fetchPhotosMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(screen.getAllByTestId("tile")).toHaveLength(2);
      expect(screen.getByText("a/2.jpg")).toBeInTheDocument();
    });
  });

  it("advances only one page when the sentinel reports twice in a batch", async () => {
    const page = (paths: string[]) => ({
      items: paths.map((path) => ({
        path,
        name: path,
        mediaType: "photo" as const,
        originalUrl: path,
        thumbnailUrl: path,
        previewUrl: path,
        fullUrl: path,
      })),
      total: 30,
      page: 0,
      pageSize: 200,
    });
    fetchPhotosMock.mockResolvedValue(page(["a/1.jpg"]));

    renderGrid();
    await waitFor(() => expect(observers.length).toBeGreaterThan(0));

    await act(async () => {
      observers.forEach((observer) => observer.trigger(true));
      observers.forEach((observer) => observer.trigger(true));
    });

    // Two page bumps would skip 200 items outright, and the path-based dedupe on
    // merge would hide the hole rather than repair it.
    await waitFor(() => expect(fetchPhotosMock).toHaveBeenCalledTimes(2));
    expect(fetchPhotosMock.mock.calls[1][0]).toMatchObject({ page: 2 });
  });

  it("shows empty-state text when no items are returned", async () => {
    fetchPhotosMock.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 0,
      pageSize: 200,
    });

    renderGrid();

    expect(
      await screen.findByText("No photos yet. Upload some to get started."),
    ).toBeInTheDocument();
    expect(screen.getByText("0 results")).toBeInTheDocument();
  });

  const stackedItem = {
    path: "a/1.jpg",
    name: "1.jpg",
    mediaType: "photo" as const,
    originalUrl: "u1",
    thumbnailUrl: "u1",
    previewUrl: "u1",
    fullUrl: "u1",
    metadata: { momentClusterId: 7, momentClusterRepresentative: true, momentClusterSize: 3 },
  };
  const clusterDetail: MomentClusterDetail = {
    id: "7",
    members: [
      {
        photo: makePhoto("a/1.jpg"),
        isRepresentative: true,
        sharpnessScore: 1,
        photoQualityScore: null,
      },
      {
        photo: makePhoto("a/1b.jpg"),
        isRepresentative: false,
        sharpnessScore: 1,
        photoQualityScore: null,
      },
      {
        photo: makePhoto("a/1c.jpg"),
        isRepresentative: false,
        sharpnessScore: 1,
        photoQualityScore: null,
      },
    ],
  };

  it("toggles a stack inline on badge click, restacks from any member, and caches the fetch", async () => {
    fetchPhotosMock.mockResolvedValueOnce({
      items: [stackedItem],
      total: 1,
      page: 0,
      pageSize: 200,
    });
    fetchMomentClusterDetailMock.mockResolvedValue(clusterDetail);

    renderGrid();

    const toggleBtn = await screen.findByTestId("toggle-stack-a/1.jpg");
    expect(toggleBtn).toHaveTextContent("3");
    // The modal must not open as a side effect of the primary toggle click.
    expect(screen.queryByTestId("stack-modal")).not.toBeInTheDocument();

    await act(async () => {
      toggleBtn.click();
    });

    // Unstacks inline: every member renders as its own tile, each with a
    // restack control; the collapsed tile/badge is gone.
    await waitFor(() => expect(fetchMomentClusterDetailMock).toHaveBeenCalledTimes(1));
    expect(fetchMomentClusterDetailMock).toHaveBeenCalledWith("7");
    expect(await screen.findByTestId("restack-a/1.jpg")).toBeInTheDocument();
    expect(screen.getByTestId("restack-a/1b.jpg")).toBeInTheDocument();
    expect(screen.getByTestId("restack-a/1c.jpg")).toBeInTheDocument();
    expect(screen.queryByTestId("toggle-stack-a/1.jpg")).not.toBeInTheDocument();

    // No wrapper element — each member is still an ordinary sibling directly
    // in the grid (no "cluster-group" test id renders). The framing is
    // border classes only: every member gets .clusterMember; every member
    // but the first also gets .clusterMemberTight (pulls it left so its
    // border overlaps the previous member's instead of sitting beside it);
    // only the first gets the "round the start corners" class and only the
    // last gets "round the end corners" — the middle member gets neither.
    expect(screen.queryByTestId("cluster-group")).not.toBeInTheDocument();
    const memberTiles = screen.getAllByTestId("tile");
    expect(memberTiles).toHaveLength(3);

    const classesOf = (el: HTMLElement) => el.className.split(" ").filter(Boolean);

    expect(classesOf(memberTiles[0])).toEqual(
      expect.arrayContaining([gridCss.clusterMember, gridCss.clusterMemberRoundStart]),
    );
    expect(classesOf(memberTiles[0])).not.toContain(gridCss.clusterMemberTight);
    expect(classesOf(memberTiles[0])).not.toContain(gridCss.clusterMemberRoundEnd);

    expect(classesOf(memberTiles[1])).toEqual([gridCss.clusterMember, gridCss.clusterMemberTight]);

    expect(classesOf(memberTiles[2])).toEqual(
      expect.arrayContaining([
        gridCss.clusterMember,
        gridCss.clusterMemberTight,
        gridCss.clusterMemberRoundEnd,
      ]),
    );
    expect(classesOf(memberTiles[2])).not.toContain(gridCss.clusterMemberRoundStart);

    // Every member gets a stable view-transition-name derived from its own
    // path, so the browser's View Transitions API (see
    // ThumbnailGrid's runWithViewTransition) can match the representative
    // tile to whichever unstacked member shares its path across a toggle.
    expect(memberTiles[0].dataset.viewTransitionName).toBe("photrix-tile-a-1-jpg");
    expect(memberTiles[1].dataset.viewTransitionName).toBe("photrix-tile-a-1b-jpg");
    expect(memberTiles[2].dataset.viewTransitionName).toBe("photrix-tile-a-1c-jpg");

    // Restacking from a DIFFERENT member than the original representative
    // still collapses the whole group back to the single tile.
    await act(async () => {
      screen.getByTestId("restack-a/1b.jpg").click();
    });

    expect(await screen.findByTestId("toggle-stack-a/1.jpg")).toHaveTextContent("3");
    expect(screen.queryByTestId("restack-a/1b.jpg")).not.toBeInTheDocument();

    // Toggling open again reuses the cached member list — no second request.
    await act(async () => {
      screen.getByTestId("toggle-stack-a/1.jpg").click();
    });
    expect(await screen.findByTestId("restack-a/1b.jpg")).toBeInTheDocument();
    expect(fetchMomentClusterDetailMock).toHaveBeenCalledTimes(1);
  });

  it("routes a synchronous toggle (cached expand / any restack) through the View Transitions API when the browser supports it, but skips it for the first (network-bound) expand", async () => {
    fetchPhotosMock.mockResolvedValueOnce({
      items: [stackedItem],
      total: 1,
      page: 0,
      pageSize: 200,
    });
    fetchMomentClusterDetailMock.mockResolvedValue(clusterDetail);

    // jsdom doesn't implement the View Transitions API — stub it the same
    // shape a supporting browser exposes (synchronously runs the callback,
    // returns a transition-like object) so runWithViewTransition's feature
    // detection takes the "supported" branch.
    const startViewTransitionMock = vi.fn((callback: () => void) => {
      callback();
      return { finished: Promise.resolve(), ready: Promise.resolve(), updateCallbackDone: Promise.resolve() };
    });
    // @ts-expect-error test-only stub of an experimental DOM API
    document.startViewTransition = startViewTransitionMock;

    try {
      renderGrid();

      const toggleBtn = await screen.findByTestId("toggle-stack-a/1.jpg");
      await act(async () => {
        toggleBtn.click();
      });
      await waitFor(() => expect(fetchMomentClusterDetailMock).toHaveBeenCalledTimes(1));
      await screen.findByTestId("restack-a/1.jpg");
      // First-ever expand is network-bound — deliberately not wrapped (see
      // handleToggleStack's comment on why holding a static page snapshot
      // for the duration of a fetch isn't worth it).
      expect(startViewTransitionMock).not.toHaveBeenCalled();

      // Restack (collapse): synchronous, cache already populated — animated.
      await act(async () => {
        screen.getByTestId("restack-a/1.jpg").click();
      });
      await screen.findByTestId("toggle-stack-a/1.jpg");
      expect(startViewTransitionMock).toHaveBeenCalledTimes(1);

      // Re-expand from cache: also synchronous — animated too.
      await act(async () => {
        screen.getByTestId("toggle-stack-a/1.jpg").click();
      });
      await screen.findByTestId("restack-a/1.jpg");
      expect(startViewTransitionMock).toHaveBeenCalledTimes(2);
      // Still only the one network request from the original expand.
      expect(fetchMomentClusterDetailMock).toHaveBeenCalledTimes(1);
    } finally {
      // @ts-expect-error cleaning up the test-only stub
      delete document.startViewTransition;
    }
  });

  it("opens the stack-actions modal via the secondary kebab, independent of the toggle", async () => {
    fetchPhotosMock.mockResolvedValueOnce({
      items: [stackedItem],
      total: 1,
      page: 0,
      pageSize: 200,
    });

    renderGrid();

    const kebab = await screen.findByTestId("stack-actions-a/1.jpg");
    // Opening the modal must not also unstack the tile inline.
    expect(screen.queryByTestId("toggle-stack-a/1.jpg")).toBeInTheDocument();

    await act(async () => {
      kebab.click();
    });

    expect(await screen.findByTestId("stack-modal")).toHaveTextContent("7");
    // The collapsed badge is still there — the kebab is a separate action.
    expect(screen.getByTestId("toggle-stack-a/1.jpg")).toBeInTheDocument();
    expect(fetchMomentClusterDetailMock).not.toHaveBeenCalled();
  });

  it("shows error text when loading fails", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    fetchPhotosMock.mockRejectedValueOnce(new Error("network down"));

    renderGrid();

    expect(await screen.findByText("Failed to fetch photos")).toBeInTheDocument();
    consoleErrorSpy.mockRestore();
  });
});
