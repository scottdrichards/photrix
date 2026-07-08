import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PeopleView } from "./PeopleView";

const fetchPeopleClustersMock = vi.fn();
const fetchClusterDetailMock = vi.fn();
const fetchFaceClustersPCAMock = vi.fn();
const mergeClustersMock = vi.fn();
const renameClusterMock = vi.fn();
const separateClusterMock = vi.fn();
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
}));

vi.mock("./filter/FilterContext", () => ({
  useFilter: () => useFilterMock(),
}));

vi.mock("./selection/SelectionContext", () => ({
  useSelectionContext: () => useSelectionContextMock(),
}));

describe("PeopleView", () => {
  beforeEach(() => {
    fetchPeopleClustersMock.mockReset();
    fetchClusterDetailMock.mockReset();
    fetchFaceClustersPCAMock.mockReset();
    mergeClustersMock.mockReset();
    renameClusterMock.mockReset();
    separateClusterMock.mockReset();
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

  it("filters the face grid to a viewed match group or suggested match and restores all faces", async () => {
    // Mock fetchPeopleClusters to return cluster summaries (no faces)
    fetchPeopleClustersMock.mockResolvedValue({
      clusters: [
        {
          id: "person-1",
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

    render(<PeopleView view="people" onViewChange={() => {}} />);

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
  });

  it("renames a cluster with a single save action", async () => {
    fetchPeopleClustersMock.mockResolvedValue({
      clusters: [
        {
          id: "person-1",
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

    render(<PeopleView view="people" onViewChange={() => {}} />);

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

    render(<PeopleView view="people" onViewChange={() => {}} />);

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

  it("separates a match group from the person detail view", async () => {
    fetchPeopleClustersMock.mockResolvedValue({
      clusters: [
        {
          id: "person-1",
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

    render(<PeopleView view="people" onViewChange={() => {}} />);

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
});
