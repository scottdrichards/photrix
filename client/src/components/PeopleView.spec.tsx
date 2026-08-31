import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PeopleView } from "./PeopleView";
import type { PeopleSelection } from "../filterUrlState";

const fetchPeopleClustersMock = vi.fn();
const fetchClusterDetailMock = vi.fn();
const fetchFaceClustersPCAMock = vi.fn();
const mergeClustersMock = vi.fn();
const renameClusterMock = vi.fn();
const separateClusterMock = vi.fn();
const setPersonTagsMock = vi.fn();
const excludeFaceFromClusterMock = vi.fn();
// Not asserted on by any test here — just needs to resolve so the
// unconditional on-mount effect in PeopleView doesn't throw for lack of a
// mocked export (was missing entirely, breaking every test in this file
// regardless of what it covered; caught while adding feedback #105 coverage).
const fetchDefaultExclusionFilterMock = vi.fn().mockResolvedValue(null);
const setDefaultExclusionFilterMock = vi.fn();
const useFilterMock = vi.fn();
const useSelectionContextMock = vi.fn();

vi.mock("../api", () => ({
  fetchPeopleClusters: (...args: unknown[]) => fetchPeopleClustersMock(...args),
  fetchClusterDetail: (...args: unknown[]) => fetchClusterDetailMock(...args),
  fetchFaceClustersPCA: (...args: unknown[]) => fetchFaceClustersPCAMock(...args),
  buildFaceCropUrl: (face: { photo: { thumbnailUrl: string } }) =>
    face.photo.thumbnailUrl,
  renameCluster: (...args: unknown[]) => renameClusterMock(...args),
  mergeClusters: (...args: unknown[]) => mergeClustersMock(...args),
  separateCluster: (...args: unknown[]) => separateClusterMock(...args),
  setPersonTags: (...args: unknown[]) => setPersonTagsMock(...args),
  excludeFaceFromCluster: (...args: unknown[]) => excludeFaceFromClusterMock(...args),
  fetchDefaultExclusionFilter: (...args: unknown[]) =>
    fetchDefaultExclusionFilterMock(...args),
  setDefaultExclusionFilter: (...args: unknown[]) => setDefaultExclusionFilterMock(...args),
}));

vi.mock("./filter/FilterContext", () => ({
  useFilter: () => useFilterMock(),
}));

vi.mock("./selection/SelectionContext", () => ({
  useSelectionContext: () => useSelectionContextMock(),
}));

type MockObserver = {
  trigger: (isIntersecting: boolean) => void;
};

const faceGridObservers: MockObserver[] = [];

beforeAll(() => {
  class FakeIntersectionObserver {
    private callback: IntersectionObserverCallback;
    private live = true;

    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
      faceGridObservers.push({
        trigger: (isIntersecting: boolean) => {
          if (!this.live) return;
          this.callback(
            [{ isIntersecting } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        },
      });
    }

    observe = vi.fn();
    disconnect = vi.fn(() => {
      this.live = false;
    });
  }

  // @ts-expect-error test override
  globalThis.IntersectionObserver = FakeIntersectionObserver;
});

/**
 * PeopleView is controlled: the person/group selection lives in App so it can
 * round-trip through the URL. This stands in for that owner, so navigating
 * inside the view actually moves it the way it does in the running app.
 */
const PeopleViewHarness = () => {
  const [selection, setSelection] = useState<PeopleSelection>({
    personId: null,
    groupId: null,
  });
  return (
    <PeopleView
      view="people"
      onViewChange={() => {}}
      personId={selection.personId}
      groupId={selection.groupId}
      onNavigate={setSelection}
    />
  );
};

describe("PeopleView", () => {
  beforeEach(() => {
    fetchPeopleClustersMock.mockReset();
    fetchClusterDetailMock.mockReset();
    fetchFaceClustersPCAMock.mockReset();
    mergeClustersMock.mockReset();
    renameClusterMock.mockReset();
    separateClusterMock.mockReset();
    faceGridObservers.length = 0;
    mergeClustersMock.mockResolvedValue(undefined);
    renameClusterMock.mockResolvedValue(undefined);
    separateClusterMock.mockResolvedValue(undefined);
    useFilterMock.mockReturnValue({
      filter: { includeSubfolders: true, path: "", mediaTypeFilter: "all" },
    });
    useSelectionContextMock.mockReturnValue({
      items: [],
      selected: null,
      setItems: vi.fn(),
      setSelected: vi.fn(),
      selectNext: vi.fn(),
      selectPrevious: vi.fn(),
    });
  });

  it(
    "filters the face grid to a viewed match group or suggested match and restores all faces",
    async () => {
    // Mock fetchPeopleClusters to return cluster summaries (no faces)
    fetchPeopleClustersMock.mockResolvedValue({
      clusters: [
        {
          id: "person-1",
          tags: [],
          count: 2,
          representative: {
            photo: {
              path: "/a.jpg",
              name: "a.jpg",
              mediaType: "photo",
              originalUrl: "http://localhost/a.jpg",
              thumbnailUrl: "http://localhost/a.jpg",
              previewUrl: "http://localhost/a.jpg",
              fullUrl: "http://localhost/a.jpg",
            },
            box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
          },
        },
        {
          id: "person-2",
          tags: [],
          count: 1,
          representative: {
            photo: {
              path: "/c.jpg",
              name: "c.jpg",
              mediaType: "photo",
              originalUrl: "http://localhost/c.jpg",
              thumbnailUrl: "http://localhost/c.jpg",
              previewUrl: "http://localhost/c.jpg",
              fullUrl: "http://localhost/c.jpg",
            },
            box: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
          },
        },
      ],
      totalFaces: 3,
      totalClusters: 2,
    });

    // Mock fetchClusterDetail to return full clusters with faces
    fetchClusterDetailMock.mockImplementation(async ({ clusterId }) => {
      if (clusterId === "person-1") {
        return {
          cluster: {
            id: "person-1",
            tags: [],
            name: "Alex",
            count: 2,
            representative: {
              photo: {
                path: "/a.jpg",
                name: "a.jpg",
                mediaType: "photo",
                originalUrl: "http://localhost/a.jpg",
                thumbnailUrl: "http://localhost/a.jpg",
                previewUrl: "http://localhost/a.jpg",
                fullUrl: "http://localhost/a.jpg",
              },
              box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
            },
            faces: [
              {
                photo: {
                  path: "/a.jpg",
                  name: "a.jpg",
                  mediaType: "photo",
                  originalUrl: "http://localhost/a.jpg",
                  thumbnailUrl: "http://localhost/a.jpg",
                  previewUrl: "http://localhost/a.jpg",
                  fullUrl: "http://localhost/a.jpg",
                },
                box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
              },
              {
                photo: {
                  path: "/b.jpg",
                  name: "b.jpg",
                  mediaType: "photo",
                  originalUrl: "http://localhost/b.jpg",
                  thumbnailUrl: "http://localhost/b.jpg",
                  previewUrl: "http://localhost/b.jpg",
                  fullUrl: "http://localhost/b.jpg",
                },
                box: { x: 0.4, y: 0.2, width: 0.2, height: 0.2 },
              },
            ],
            centroids: [
              {
                id: "person-4",
                tags: [],
                count: 3,
                representative: {
                  photo: {
                    path: "/d.jpg",
                    name: "d.jpg",
                    mediaType: "photo",
                    originalUrl: "http://localhost/d.jpg",
                    thumbnailUrl: "http://localhost/d.jpg",
                    previewUrl: "http://localhost/d.jpg",
                    fullUrl: "http://localhost/d.jpg",
                  },
                  box: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
                },
              },
            ],
            mergeSuggestions: [
              {
                id: "person-3",
                tags: [],
                count: 2,
                name: "Casey",
                yearRangeLabel: "1998-2001",
                representative: {
                  photo: {
                    path: "/c2.jpg",
                    name: "c2.jpg",
                    mediaType: "photo",
                    originalUrl: "http://localhost/c2.jpg",
                    thumbnailUrl: "http://localhost/c2.jpg",
                    previewUrl: "http://localhost/c2.jpg",
                    fullUrl: "http://localhost/c2.jpg",
                  },
                  box: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
                },
              },
            ],
          },
        };
      }
      if (clusterId === "person-2") {
        return {
          cluster: {
            id: "person-2",
            tags: [],
            count: 1,
            representative: {
              photo: {
                path: "/c.jpg",
                name: "c.jpg",
                mediaType: "photo",
                originalUrl: "http://localhost/c.jpg",
                thumbnailUrl: "http://localhost/c.jpg",
                previewUrl: "http://localhost/c.jpg",
                fullUrl: "http://localhost/c.jpg",
              },
              box: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
            },
            faces: [
              {
                photo: {
                  path: "/c.jpg",
                  name: "c.jpg",
                  mediaType: "photo",
                  originalUrl: "http://localhost/c.jpg",
                  thumbnailUrl: "http://localhost/c.jpg",
                  previewUrl: "http://localhost/c.jpg",
                  fullUrl: "http://localhost/c.jpg",
                },
                box: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
              },
            ],
            centroids: [],
            mergeSuggestions: [],
          },
        };
      }
      if (clusterId === "person-3") {
        return {
          cluster: {
            id: "person-3",
            tags: [],
            count: 2,
            name: "Casey",
            representative: {
              photo: {
                path: "/c2.jpg",
                name: "c2.jpg",
                mediaType: "photo",
                originalUrl: "http://localhost/c2.jpg",
                thumbnailUrl: "http://localhost/c2.jpg",
                previewUrl: "http://localhost/c2.jpg",
                fullUrl: "http://localhost/c2.jpg",
              },
              box: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
            },
            faces: [
              {
                photo: {
                  path: "/c2.jpg",
                  name: "c2.jpg",
                  mediaType: "photo",
                  originalUrl: "http://localhost/c2.jpg",
                  thumbnailUrl: "http://localhost/c2.jpg",
                  previewUrl: "http://localhost/c2.jpg",
                  fullUrl: "http://localhost/c2.jpg",
                },
                box: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
              },
              {
                photo: {
                  path: "/c3.jpg",
                  name: "c3.jpg",
                  mediaType: "photo",
                  originalUrl: "http://localhost/c3.jpg",
                  thumbnailUrl: "http://localhost/c3.jpg",
                  previewUrl: "http://localhost/c3.jpg",
                  fullUrl: "http://localhost/c3.jpg",
                },
                box: { x: 0.22, y: 0.2, width: 0.2, height: 0.2 },
              },
            ],
            centroids: [],
            mergeSuggestions: [],
          },
        };
      }
      if (clusterId === "person-4") {
        return {
          cluster: {
            id: "person-4",
            tags: [],
            count: 3,
            name: null,
            representative: {
              photo: {
                path: "/d.jpg",
                name: "d.jpg",
                mediaType: "photo",
                originalUrl: "http://localhost/d.jpg",
                thumbnailUrl: "http://localhost/d.jpg",
                previewUrl: "http://localhost/d.jpg",
                fullUrl: "http://localhost/d.jpg",
              },
              box: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
            },
            faces: [
              {
                photo: {
                  path: "/d.jpg",
                  name: "d.jpg",
                  mediaType: "photo",
                  originalUrl: "http://localhost/d.jpg",
                  thumbnailUrl: "http://localhost/d.jpg",
                  previewUrl: "http://localhost/d.jpg",
                  fullUrl: "http://localhost/d.jpg",
                },
                box: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
              },
              {
                photo: {
                  path: "/e.jpg",
                  name: "e.jpg",
                  mediaType: "photo",
                  originalUrl: "http://localhost/e.jpg",
                  thumbnailUrl: "http://localhost/e.jpg",
                  previewUrl: "http://localhost/e.jpg",
                  fullUrl: "http://localhost/e.jpg",
                },
                box: { x: 0.35, y: 0.3, width: 0.2, height: 0.2 },
              },
            ],
            centroids: [],
            mergeSuggestions: [],
          },
        };
      }
      return { cluster: null };
    });

    render(<PeopleViewHarness />);

    // Cluster list is shown initially
    await waitFor(() => {
      expect(screen.getByText("2 clusters • 3 faces")).toBeInTheDocument();
      expect(screen.getByText("2 faces")).toBeInTheDocument();
      expect(screen.getByText("1 faces")).toBeInTheDocument();
    });

    // Click person-1 cluster to navigate into detail view
    fireEvent.click(screen.getByText("2 faces").closest("button") as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.getByText("← Back")).toBeInTheDocument();
      expect(screen.getByText("Match Groups")).toBeInTheDocument();
      expect(screen.getByText("Suggested matches")).toBeInTheDocument();
      expect(screen.getByText("All faces")).toBeInTheDocument();
      expect(screen.getByText("3 faces")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Separate person-4 from Alex" })).toBeInTheDocument();
      expect(screen.getByText("Casey")).toBeInTheDocument();
      expect(screen.getByText("1998-2001")).toBeInTheDocument();
      expect(screen.getAllByLabelText("a.jpg").length).toBeGreaterThan(0);
    });

    const matchGroupCard = screen
      .getByRole("button", { name: "Separate person-4 from Alex" })
      .closest("article") as HTMLElement;
    fireEvent.click(within(matchGroupCard).getByRole("button", { name: "View" }));

    await waitFor(() => {
      expect(screen.getByText("Selected Match Group Faces")).toBeInTheDocument();
      expect(screen.getAllByText("3 faces").length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: "Show all faces" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "d.jpg" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "e.jpg" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "a.jpg" })).not.toBeInTheDocument();
    });

    // Feedback #105: viewing a match group must ask the server to scope to
    // that sub-cluster's own faces (exactCluster), not silently widen back
    // out to the whole merged person it belongs to.
    const calls = fetchClusterDetailMock.mock.calls as [{ clusterId: string; exactCluster?: boolean }][];
    const groupCall = calls.find((call) => call[0].clusterId === "person-4");
    expect(groupCall?.[0]).toMatchObject({ exactCluster: true });
    const personCall = calls.find((call) => call[0].clusterId === "person-1");
    expect(personCall?.[0].exactCluster).toBeFalsy();

    const suggestedMatchCard = screen.getByText("Casey").closest("article") as HTMLElement;
    fireEvent.click(within(suggestedMatchCard).getByRole("button", { name: "View" }));

    await waitFor(() => {
      expect(screen.getByText("Selected Match Group Faces")).toBeInTheDocument();
      expect(screen.getAllByText("Casey").length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: "c2.jpg" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "c3.jpg" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "d.jpg" })).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Show all faces" }));

    await waitFor(() => {
      expect(screen.getByText("All faces")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "a.jpg" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "b.jpg" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "c2.jpg" })).not.toBeInTheDocument();
    });
    },
    10_000,
  );

  it("renames a cluster with a single save action", async () => {
    fetchPeopleClustersMock.mockResolvedValue({
      clusters: [
        {
          id: "person-1",
          tags: [],
          count: 2,
          name: null,
          representative: {
            photo: {
              path: "/a.jpg",
              name: "a.jpg",
              mediaType: "photo",
              originalUrl: "http://localhost/a.jpg",
              thumbnailUrl: "http://localhost/a.jpg",
              previewUrl: "http://localhost/a.jpg",
              fullUrl: "http://localhost/a.jpg",
            },
            box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
          },
        },
      ],
      totalFaces: 2,
      totalClusters: 1,
      pendingFaces: 0,
    });

    render(<PeopleViewHarness />);

    await waitFor(() => {
      expect(screen.getByText("Add name…")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Add name…"));
    fireEvent.change(screen.getByPlaceholderText("Enter name…"), {
      target: { value: "Taylor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "✓" }));

    await waitFor(() => {
      expect(renameClusterMock).toHaveBeenCalledTimes(1);
      expect(renameClusterMock).toHaveBeenCalledWith("person-1", "Taylor");
      expect(screen.getByText("Taylor")).toBeInTheDocument();
    });
  });

  it("merges a suggested match from the person detail view", async () => {
    let resolveBackgroundDetail:
      | ((value: { cluster: Record<string, unknown> | null }) => void)
      | undefined;
    const backgroundDetail = new Promise<{ cluster: Record<string, unknown> | null }>((resolve) => {
      resolveBackgroundDetail = resolve;
    });

    fetchPeopleClustersMock.mockResolvedValue({
      clusters: [
        {
          id: "person-1",
          tags: [],
          count: 2,
          name: "Alex",
          representative: {
            photo: {
              path: "/a.jpg",
              name: "a.jpg",
              mediaType: "photo",
              originalUrl: "http://localhost/a.jpg",
              thumbnailUrl: "http://localhost/a.jpg",
              previewUrl: "http://localhost/a.jpg",
              fullUrl: "http://localhost/a.jpg",
            },
            box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
          },
        },
      ],
      totalFaces: 2,
      totalClusters: 1,
      pendingFaces: 0,
    });

    fetchClusterDetailMock
      .mockResolvedValueOnce({
        cluster: {
          id: "person-1",
          tags: [],
          count: 2,
          name: "Alex",
          representative: {
            photo: {
              path: "/a.jpg",
              name: "a.jpg",
              mediaType: "photo",
              originalUrl: "http://localhost/a.jpg",
              thumbnailUrl: "http://localhost/a.jpg",
              previewUrl: "http://localhost/a.jpg",
              fullUrl: "http://localhost/a.jpg",
            },
            box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
          },
          faces: [
            {
              photo: {
                path: "/a.jpg",
                name: "a.jpg",
                mediaType: "photo",
                originalUrl: "http://localhost/a.jpg",
                thumbnailUrl: "http://localhost/a.jpg",
                previewUrl: "http://localhost/a.jpg",
                fullUrl: "http://localhost/a.jpg",
              },
              box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
            },
          ],
          centroids: [],
            mergeSuggestions: [
              {
                id: "person-2",
                tags: [],
                count: 2,
                name: null,
                representative: {
                  photo: {
                  path: "/b.jpg",
                  name: "b.jpg",
                  mediaType: "photo",
                  originalUrl: "http://localhost/b.jpg",
                  thumbnailUrl: "http://localhost/b.jpg",
                  previewUrl: "http://localhost/b.jpg",
                  fullUrl: "http://localhost/b.jpg",
                },
                box: { x: 0.4, y: 0.2, width: 0.2, height: 0.2 },
              },
            },
          ],
        },
      })
      .mockImplementationOnce(() => backgroundDetail);

    render(<PeopleViewHarness />);

    await waitFor(() => {
      expect(screen.getByText("Alex")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("2 faces").closest("button") as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Merge person-2 into Alex" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Merge person-2 into Alex" }));

    await waitFor(() => {
      expect(mergeClustersMock).toHaveBeenCalledWith(["person-2"], "person-1");
      expect(screen.getByText("4 faces")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Separate person-2 from Alex" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Merge person-2 into Alex" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "merged-face.jpg" })).not.toBeInTheDocument();
    });

    resolveBackgroundDetail?.({
      cluster: {
        id: "person-1",
        tags: [],
        count: 4,
        name: "Alex",
        representative: {
          photo: {
            path: "/a.jpg",
            name: "a.jpg",
            mediaType: "photo",
            originalUrl: "http://localhost/a.jpg",
            thumbnailUrl: "http://localhost/a.jpg",
            previewUrl: "http://localhost/a.jpg",
            fullUrl: "http://localhost/a.jpg",
          },
          box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
        },
        faces: [
          {
            photo: {
              path: "/a.jpg",
              name: "a.jpg",
              mediaType: "photo",
              originalUrl: "http://localhost/a.jpg",
              thumbnailUrl: "http://localhost/a.jpg",
              previewUrl: "http://localhost/a.jpg",
              fullUrl: "http://localhost/a.jpg",
            },
            box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
          },
          {
            photo: {
              path: "/merged-face.jpg",
              name: "merged-face.jpg",
              mediaType: "photo",
              originalUrl: "http://localhost/merged-face.jpg",
              thumbnailUrl: "http://localhost/merged-face.jpg",
              previewUrl: "http://localhost/merged-face.jpg",
              fullUrl: "http://localhost/merged-face.jpg",
            },
            box: { x: 0.4, y: 0.2, width: 0.2, height: 0.2 },
          },
        ],
        centroids: [
          {
            id: "person-2",
            tags: [],
            count: 2,
            representative: {
              photo: {
                path: "/b.jpg",
                name: "b.jpg",
                mediaType: "photo",
                originalUrl: "http://localhost/b.jpg",
                thumbnailUrl: "http://localhost/b.jpg",
                previewUrl: "http://localhost/b.jpg",
                fullUrl: "http://localhost/b.jpg",
              },
              box: { x: 0.4, y: 0.2, width: 0.2, height: 0.2 },
            },
          },
        ],
        mergeSuggestions: [],
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "merged-face.jpg" })).toBeInTheDocument();
    });
  });

  it("aborts an earlier suggested merge's refresh when a newer merge supersedes it", async () => {
    const photo = (path: string) => ({
      path,
      name: path,
      mediaType: "photo" as const,
      originalUrl: `http://localhost/${path}`,
      thumbnailUrl: `http://localhost/${path}`,
      previewUrl: `http://localhost/${path}`,
      fullUrl: `http://localhost/${path}`,
    });
    const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.3 };

    fetchPeopleClustersMock.mockResolvedValue({
      clusters: [
        {
          id: "person-1",
          tags: [],
          count: 2,
          name: "Alex",
          representative: { photo: photo("a.jpg"), box },
        },
      ],
      totalFaces: 2,
      totalClusters: 1,
      pendingFaces: 0,
    });

    // Call #1: initial detail load (two suggestions pending).
    fetchClusterDetailMock.mockResolvedValueOnce({
      cluster: {
        id: "person-1",
        tags: [],
        count: 2,
        name: "Alex",
        representative: { photo: photo("a.jpg"), box },
        faces: [{ photo: photo("a.jpg"), box }],
        centroids: [],
        mergeSuggestions: [
          { id: "person-2", count: 1, name: null, representative: { photo: photo("b.jpg"), box } },
          { id: "person-3", count: 1, name: null, representative: { photo: photo("c.jpg"), box } },
        ],
      },
    });

    // Call #2: the background refresh kicked off by merging suggestion
    // person-2 — this is the stale one that must never win. Modeled on real
    // fetch semantics (which the production code relies on): it only settles
    // by rejecting once its signal is aborted, exactly like a real in-flight
    // request cancelled by AbortController.abort().
    fetchClusterDetailMock.mockImplementationOnce(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );

    // Call #3: the background refresh kicked off by the superseding merge of
    // suggestion person-3 — this one must win.
    fetchClusterDetailMock.mockResolvedValueOnce({
      cluster: {
        id: "person-1",
        tags: [],
        count: 4,
        name: "Alex",
        representative: { photo: photo("a.jpg"), box },
        faces: [
          { photo: photo("a.jpg"), box },
          { photo: photo("b.jpg"), box },
          { photo: photo("c.jpg"), box },
        ],
        centroids: [],
        mergeSuggestions: [],
      },
    });

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<PeopleViewHarness />);

    await waitFor(() => {
      expect(screen.getByText("Alex")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("2 faces").closest("button") as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Merge person-2 into Alex" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Merge person-3 into Alex" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Merge person-2 into Alex" }));

    // Let the merge (A) resolve and its background refresh (call #2) start —
    // it's the never-settling-until-abort promise from above.
    await waitFor(() => {
      expect(mergeClustersMock).toHaveBeenCalledWith(["person-2"], "person-1");
      expect(fetchClusterDetailMock).toHaveBeenCalledTimes(2);
    });

    const staleSignal = fetchClusterDetailMock.mock.calls[1][0].signal as AbortSignal;
    expect(staleSignal.aborted).toBe(false);

    // Merge B (person-3) fires before A's background refresh ever settles —
    // "quick succession". Its handler must abort A's refresh synchronously.
    fireEvent.click(screen.getByRole("button", { name: "Merge person-3 into Alex" }));
    expect(staleSignal.aborted).toBe(true);

    await waitFor(() => {
      expect(mergeClustersMock).toHaveBeenCalledWith(["person-3"], "person-1");
      // The correct, superseding refresh landed and neither suggestion chip
      // reappeared — no disappear/reappear/disappear flicker.
      expect(screen.queryByRole("button", { name: "Merge person-2 into Alex" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Merge person-3 into Alex" })).not.toBeInTheDocument();
    });

    // The aborted stale request settles (rejects) quietly — it must not be
    // logged as a real failure.
    await waitFor(() => {
      expect(
        consoleErrorSpy.mock.calls.some(([msg]) =>
          String(msg).includes("Failed to refresh merged cluster detail"),
        ),
      ).toBe(false);
    });

    consoleErrorSpy.mockRestore();
  });

  it("lets suggested matches be dismissed locally until the page is reloaded", async () => {
    fetchPeopleClustersMock.mockResolvedValue({
      clusters: [
        {
          id: "person-1",
          tags: [],
          count: 2,
          name: "Alex",
          representative: {
            photo: {
              path: "/a.jpg",
              name: "a.jpg",
              mediaType: "photo",
              originalUrl: "http://localhost/a.jpg",
              thumbnailUrl: "http://localhost/a.jpg",
              previewUrl: "http://localhost/a.jpg",
              fullUrl: "http://localhost/a.jpg",
            },
            box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
          },
        },
      ],
      totalFaces: 2,
      totalClusters: 1,
      pendingFaces: 0,
    });

    fetchClusterDetailMock.mockResolvedValue({
      cluster: {
        id: "person-1",
        tags: [],
        count: 2,
        name: "Alex",
        representative: {
          photo: {
            path: "/a.jpg",
            name: "a.jpg",
            mediaType: "photo",
            originalUrl: "http://localhost/a.jpg",
            thumbnailUrl: "http://localhost/a.jpg",
            previewUrl: "http://localhost/a.jpg",
            fullUrl: "http://localhost/a.jpg",
          },
          box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
        },
        faces: [],
        centroids: [],
        mergeSuggestions: [
          {
            id: "person-2",
            tags: [],
            count: 1,
            name: null,
            representative: {
              photo: {
                path: "/b.jpg",
                name: "b.jpg",
                mediaType: "photo",
                originalUrl: "http://localhost/b.jpg",
                thumbnailUrl: "http://localhost/b.jpg",
                previewUrl: "http://localhost/b.jpg",
                fullUrl: "http://localhost/b.jpg",
              },
              box: { x: 0.4, y: 0.2, width: 0.2, height: 0.2 },
            },
          },
        ],
      },
    });

    const { unmount } = render(<PeopleViewHarness />);

    await waitFor(() => {
      expect(screen.getByText("Alex")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("2 faces").closest("button") as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Dismiss suggested match person-2" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggested match person-2" }));

    expect(screen.queryByRole("button", { name: "Merge person-2 into Alex" })).not.toBeInTheDocument();

    unmount();
    render(<PeopleViewHarness />);

    await waitFor(() => {
      expect(screen.getByText("Alex")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("2 faces").closest("button") as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Merge person-2 into Alex" })).toBeInTheDocument();
    });
  });

  it("separates a match group from the person detail view", async () => {
    fetchPeopleClustersMock.mockResolvedValue({
      clusters: [
        {
          id: "person-1",
          tags: [],
          count: 4,
          name: "Alex",
          representative: {
            photo: {
              path: "/a.jpg",
              name: "a.jpg",
              mediaType: "photo",
              originalUrl: "http://localhost/a.jpg",
              thumbnailUrl: "http://localhost/a.jpg",
              previewUrl: "http://localhost/a.jpg",
              fullUrl: "http://localhost/a.jpg",
            },
            box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
          },
        },
      ],
      totalFaces: 4,
      totalClusters: 1,
      pendingFaces: 0,
    });

    fetchClusterDetailMock
      .mockResolvedValueOnce({
        cluster: {
          id: "person-1",
          tags: [],
          count: 4,
          name: "Alex",
          representative: {
            photo: {
              path: "/a.jpg",
              name: "a.jpg",
              mediaType: "photo",
              originalUrl: "http://localhost/a.jpg",
              thumbnailUrl: "http://localhost/a.jpg",
              previewUrl: "http://localhost/a.jpg",
              fullUrl: "http://localhost/a.jpg",
            },
            box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
          },
          faces: [
            {
              photo: {
                path: "/a.jpg",
                name: "a.jpg",
                mediaType: "photo",
                originalUrl: "http://localhost/a.jpg",
                thumbnailUrl: "http://localhost/a.jpg",
                previewUrl: "http://localhost/a.jpg",
                fullUrl: "http://localhost/a.jpg",
              },
              box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
            },
          ],
          centroids: [
            {
              id: "person-1",
              tags: [],
              count: 2,
              representative: {
                photo: {
                  path: "/a.jpg",
                  name: "a.jpg",
                  mediaType: "photo",
                  originalUrl: "http://localhost/a.jpg",
                  thumbnailUrl: "http://localhost/a.jpg",
                  previewUrl: "http://localhost/a.jpg",
                  fullUrl: "http://localhost/a.jpg",
                },
                box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
              },
            },
            {
              id: "person-2",
              tags: [],
              count: 2,
              representative: {
                photo: {
                  path: "/b.jpg",
                  name: "b.jpg",
                  mediaType: "photo",
                  originalUrl: "http://localhost/b.jpg",
                  thumbnailUrl: "http://localhost/b.jpg",
                  previewUrl: "http://localhost/b.jpg",
                  fullUrl: "http://localhost/b.jpg",
                },
                box: { x: 0.4, y: 0.2, width: 0.2, height: 0.2 },
              },
            },
          ],
          mergeSuggestions: [],
        },
      })
      .mockResolvedValueOnce({
        cluster: {
          id: "person-1",
          tags: [],
          count: 2,
          name: "Alex",
          representative: {
            photo: {
              path: "/a.jpg",
              name: "a.jpg",
              mediaType: "photo",
              originalUrl: "http://localhost/a.jpg",
              thumbnailUrl: "http://localhost/a.jpg",
              previewUrl: "http://localhost/a.jpg",
              fullUrl: "http://localhost/a.jpg",
            },
            box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
          },
          faces: [
            {
              photo: {
                path: "/a.jpg",
                name: "a.jpg",
                mediaType: "photo",
                originalUrl: "http://localhost/a.jpg",
                thumbnailUrl: "http://localhost/a.jpg",
                previewUrl: "http://localhost/a.jpg",
                fullUrl: "http://localhost/a.jpg",
              },
              box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
            },
          ],
          centroids: [
            {
              id: "person-1",
              tags: [],
              count: 2,
              representative: {
                photo: {
                  path: "/a.jpg",
                  name: "a.jpg",
                  mediaType: "photo",
                  originalUrl: "http://localhost/a.jpg",
                  thumbnailUrl: "http://localhost/a.jpg",
                  previewUrl: "http://localhost/a.jpg",
                  fullUrl: "http://localhost/a.jpg",
                },
                box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
              },
            },
          ],
          mergeSuggestions: [],
        },
      });

    render(<PeopleViewHarness />);

    await waitFor(() => {
      expect(screen.getByText("Alex")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("4 faces").closest("button") as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Separate person-2 from Alex" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Separate person-2 from Alex" }));

    await waitFor(() => {
      expect(separateClusterMock).toHaveBeenCalledWith("person-2");
      expect(screen.getAllByText("2 faces").length).toBeGreaterThan(0);
    });
  });

  it("opens the person page before their faces arrive", async () => {
    fetchPeopleClustersMock.mockResolvedValue({
      clusters: [
        {
          id: "person-1",
          tags: [],
          count: 2,
          name: "Alex",
          representative: {
            photo: {
              path: "/a.jpg",
              name: "a.jpg",
              mediaType: "photo",
              originalUrl: "http://localhost/a.jpg",
              thumbnailUrl: "http://localhost/a.jpg",
              previewUrl: "http://localhost/a.jpg",
              fullUrl: "http://localhost/a.jpg",
            },
            box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
          },
        },
      ],
      totalClusters: 1,
      totalFaces: 2,
    });

    // Hold the detail request open so the "still loading" window is observable.
    let resolveDetail: (value: unknown) => void = () => {};
    fetchClusterDetailMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDetail = resolve;
        }),
    );

    render(<PeopleViewHarness />);
    await screen.findByText("2 faces");

    fireEvent.click(screen.getByText("2 faces").closest("button") as HTMLButtonElement);

    // The page is already the person's, built from the card that was clicked —
    // name and face included — while the faces are still in flight.
    expect(await screen.findByText("← Back")).toBeInTheDocument();
    expect(screen.getByText("Alex")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "a.jpg" })).not.toBeInTheDocument();

    resolveDetail({
      cluster: {
        id: "person-1",
        tags: [],
        name: "Alex",
        count: 2,
        representative: {
          photo: {
            path: "/a.jpg",
            name: "a.jpg",
            mediaType: "photo",
            originalUrl: "http://localhost/a.jpg",
            thumbnailUrl: "http://localhost/a.jpg",
            previewUrl: "http://localhost/a.jpg",
            fullUrl: "http://localhost/a.jpg",
          },
          box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
        },
        faces: [
          {
            photo: {
              path: "/a.jpg",
              name: "a.jpg",
              mediaType: "photo",
              originalUrl: "http://localhost/a.jpg",
              thumbnailUrl: "http://localhost/a.jpg",
              previewUrl: "http://localhost/a.jpg",
              fullUrl: "http://localhost/a.jpg",
            },
            box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
          },
        ],
        centroids: [],
        mergeSuggestions: [],
      },
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "a.jpg" })).toBeInTheDocument();
    });
  });

  it("paginates a large cluster's face grid instead of mounting every face crop at once (feedback #89)", async () => {
    const photo = (path: string) => ({
      path,
      name: path,
      mediaType: "photo" as const,
      originalUrl: `http://localhost/${path}`,
      thumbnailUrl: `http://localhost/${path}`,
      previewUrl: `http://localhost/${path}`,
      fullUrl: `http://localhost/${path}`,
    });
    const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.3 };
    const manyFaces = Array.from({ length: 150 }, (_, i) => ({
      photo: photo(`face-${i}.jpg`),
      box,
    }));

    fetchPeopleClustersMock.mockResolvedValue({
      clusters: [
        {
          id: "person-1",
          tags: [],
          count: manyFaces.length,
          name: "Alex",
          representative: { photo: photo("face-0.jpg"), box },
        },
      ],
      totalFaces: manyFaces.length,
      totalClusters: 1,
      pendingFaces: 0,
    });

    fetchClusterDetailMock.mockResolvedValue({
      cluster: {
        id: "person-1",
        tags: [],
        count: manyFaces.length,
        name: "Alex",
        representative: { photo: photo("face-0.jpg"), box },
        faces: manyFaces,
        centroids: [],
        mergeSuggestions: [],
      },
    });

    render(<PeopleViewHarness />);
    fireEvent.click(await screen.findByRole("button", { name: /^face-0\.jpg/ }));

    // Only the first page mounts up front — the rest of a 150-face cluster
    // must not all become real <img> elements before the user scrolls.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "face-0.jpg" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "face-149.jpg" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^face-\d+\.jpg$/ }).length).toBeLessThan(
      manyFaces.length,
    );

    // Scrolling the sentinel into view reveals more.
    expect(faceGridObservers.length).toBeGreaterThan(0);
    faceGridObservers[faceGridObservers.length - 1].trigger(true);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "face-149.jpg" })).toBeInTheDocument();
    });
  });
});
