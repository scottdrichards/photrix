import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PeopleView } from "./PeopleView";

const fetchPeopleClustersMock = vi.fn();
const fetchClusterDetailMock = vi.fn();
const useFilterMock = vi.fn();
const useSelectionContextMock = vi.fn();

vi.mock("../api", () => ({
  fetchPeopleClusters: (...args: unknown[]) => fetchPeopleClustersMock(...args),
  fetchClusterDetail: (...args: unknown[]) => fetchClusterDetailMock(...args),
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
    useFilterMock.mockReturnValue({
      filter: { includeSubfolders: true, path: "", mediaTypeFilter: "all" },
    });
    useSelectionContextMock.mockReturnValue({
      isSelected: vi.fn(() => false),
      selectionMode: false,
      setItems: vi.fn(),
      setSelected: vi.fn(),
      toggleSelected: vi.fn(),
    });
  });

  it("renders clusters and face thumbnails, then updates selected cluster", async () => {
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
          },
        };
      }
      return { cluster: null };
    });

    render(<PeopleView />);

    // Cluster list is shown initially
    await waitFor(() => {
      expect(screen.getByText("2 clusters • 3 faces")).toBeInTheDocument();
      expect(screen.getByText("2 faces")).toBeInTheDocument();
      expect(screen.getByText("1 faces")).toBeInTheDocument();
    });

    const representativeFace = screen.getByAltText("a.jpg");
    expect(representativeFace).toHaveStyle({
      transform: "translate(48%, 36%) scale(1.2)",
    });

    // Click person-1 cluster to navigate into detail view
    fireEvent.click(screen.getByText("2 faces").closest("button") as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.getByText("← Back")).toBeInTheDocument();
      expect(screen.getAllByLabelText("a.jpg").length).toBeGreaterThan(0);
    });

    // Go back to cluster list
    fireEvent.click(screen.getByText("← Back"));

    await waitFor(() => {
      expect(screen.getByText("2 clusters • 3 faces")).toBeInTheDocument();
    });

    // Click person-2 cluster
    fireEvent.click(screen.getByText("1 faces").closest("button") as HTMLButtonElement);

    await waitFor(() => {
      expect(screen.getAllByLabelText("c.jpg").length).toBeGreaterThan(0);
    });
  });
});
