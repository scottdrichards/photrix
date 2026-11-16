import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PeopleView } from "./PeopleView";
import type { PeopleSelection } from "../../filterUrlState";

/**
 * Changing the filter while the People view has requests in flight. Each test
 * holds a request open, changes the filter, then lets the old answer land
 * late, which is the order a slow server produces.
 */

const fetchPeopleClustersMock = vi.fn();
const fetchClusterDetailMock = vi.fn();
const mergeClustersMock = vi.fn();
const useFilterMock = vi.fn();

vi.mock("../../api", () => ({
  fetchPeopleClusters: (...args: unknown[]) => fetchPeopleClustersMock(...args),
  fetchClusterDetail: (...args: unknown[]) => fetchClusterDetailMock(...args),
  fetchFaceClustersPCA: vi.fn(),
  buildFaceCropUrl: (face: { photo: { thumbnailUrl: string } }) => face.photo.thumbnailUrl,
  renameCluster: vi.fn(),
  mergeClusters: (...args: unknown[]) => mergeClustersMock(...args),
  separateCluster: vi.fn(),
  setPersonTags: vi.fn(),
  excludeFaceFromCluster: vi.fn(),
  fetchDefaultExclusionFilter: vi.fn().mockResolvedValue(null),
  setDefaultExclusionFilter: vi.fn(),
}));

vi.mock("../filter/FilterContext", () => ({
  useFilter: () => useFilterMock(),
}));

vi.mock("../selection/SelectionContext", () => ({
  useSelectionContext: () => ({
    items: [],
    selected: null,
    setItems: setItemsMock,
    setSelected: vi.fn(),
    selectNext: vi.fn(),
    selectPrevious: vi.fn(),
  }),
}));

// Stable across renders: PeopleView's effects depend on it.
const setItemsMock = vi.fn();

beforeAll(() => {
  class FakeIntersectionObserver {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  // @ts-expect-error test override
  globalThis.IntersectionObserver = FakeIntersectionObserver;
});

const face = (file: string) => ({
  photo: {
    path: `/${file}`,
    name: file,
    mediaType: "photo",
    originalUrl: `http://localhost/${file}`,
    thumbnailUrl: `http://localhost/${file}`,
    previewUrl: `http://localhost/${file}`,
    fullUrl: `http://localhost/${file}`,
  },
  box: { x: 0.1, y: 0.2, width: 0.3, height: 0.3 },
});

const card = (id: string, name: string, count: number) => ({
  id,
  name,
  count,
  tags: [],
  representative: face(`${name}.jpg`),
});

const list = (...clusters: ReturnType<typeof card>[]) => ({
  clusters,
  totalClusters: clusters.length,
  totalFaces: clusters.reduce((sum, cluster) => sum + cluster.count, 0),
  pendingFaces: 0,
});

const detail = (id: string, name: string, files: string[]) => ({
  cluster: {
    ...card(id, name, files.length),
    faces: files.map(face),
    centroids: [],
    mergeSuggestions: [],
  },
});

type Pending = {
  options: { signal?: AbortSignal; dateRange?: unknown };
  resolve: (value: unknown) => void;
};

/**
 * A fetch that stays open until the test settles it and, like the real one,
 * rejects as soon as its signal aborts.
 */
const heldOpen = (calls: Pending[]) => (options: Pending["options"]) =>
  new Promise((resolve, reject) => {
    calls.push({ options, resolve });
    options.signal?.addEventListener("abort", () =>
      reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError")),
    );
  });

const ALL = { includeSubfolders: true, path: "", mediaTypeFilter: "all" };
const NARROW = { ...ALL, dateRange: { start: 1, end: 2 } };

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

const flush = () => act(async () => {});

describe("PeopleView when the filter changes mid-request", () => {
  let clusterCalls: Pending[];
  let detailCalls: Pending[];

  beforeEach(() => {
    clusterCalls = [];
    detailCalls = [];
    fetchPeopleClustersMock.mockReset().mockImplementation(heldOpen(clusterCalls));
    fetchClusterDetailMock.mockReset().mockImplementation(heldOpen(detailCalls));
    mergeClustersMock.mockReset().mockResolvedValue(undefined);
    useFilterMock.mockReturnValue({ filter: ALL });
  });

  const changeFilter = async (view: ReturnType<typeof render>, filter: object) => {
    useFilterMock.mockReturnValue({ filter });
    view.rerender(<PeopleViewHarness />);
    await flush();
  };

  it("keeps the spinner up while the new filter's people are loading", async () => {
    const view = render(<PeopleViewHarness />);
    await flush();
    expect(view.container.querySelector(".spinner-dot")).not.toBeNull();

    // The first request is still open when the filter changes: it is aborted
    // and settles *after* the second request has started.
    await changeFilter(view, NARROW);
    expect(clusterCalls).toHaveLength(2);
    expect(clusterCalls[0].options.signal?.aborted).toBe(true);
    expect(view.container.querySelector(".spinner-dot")).not.toBeNull();

    await act(async () => clusterCalls[1].resolve(list(card("person-2", "Bo", 3))));
    expect(await screen.findByText("3 faces")).toBeInTheDocument();
    expect(view.container.querySelector(".spinner-dot")).toBeNull();
  });

  it("reloads a person whose first load was still in flight", async () => {
    const view = render(<PeopleViewHarness />);
    await act(async () => clusterCalls[0].resolve(list(card("person-1", "Alex", 2))));

    fireEvent.click(screen.getByText("2 faces").closest("button") as HTMLButtonElement);
    await flush();
    expect(detailCalls).toHaveLength(1);

    await changeFilter(view, NARROW);
    await act(async () => clusterCalls[1].resolve(list(card("person-1", "Alex", 1))));

    // The open person is asked for again, under the new filter.
    expect(detailCalls).toHaveLength(2);
    expect(detailCalls[1].options.dateRange).toEqual(NARROW.dateRange);

    // The old filter's faces arrive last and must not be the ones shown.
    await act(async () =>
      detailCalls[1].resolve(detail("person-1", "Alex", ["narrow.jpg"])),
    );
    await act(async () =>
      detailCalls[0].resolve(detail("person-1", "Alex", ["old-1.jpg", "old-2.jpg"])),
    );

    expect(screen.getByRole("button", { name: "narrow.jpg" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "old-1.jpg" })).not.toBeInTheDocument();
  });

  it("does not leave a person's page because they had no faces under the old filter", async () => {
    const view = render(<PeopleViewHarness />);
    await act(async () => clusterCalls[0].resolve(list(card("person-1", "Alex", 2))));

    fireEvent.click(screen.getByText("2 faces").closest("button") as HTMLButtonElement);
    await flush();
    await changeFilter(view, NARROW);
    await act(async () => clusterCalls[1].resolve(list(card("person-1", "Alex", 1))));

    await act(async () => detailCalls[0].resolve({ cluster: null }));
    expect(screen.getByText("← Back")).toBeInTheDocument();

    await act(async () =>
      detailCalls[1].resolve(detail("person-1", "Alex", ["narrow.jpg"])),
    );
    expect(screen.getByRole("button", { name: "narrow.jpg" })).toBeInTheDocument();
  });

  it("drops a post-merge refresh that answers for the previous filter", async () => {
    const view = render(<PeopleViewHarness />);
    await act(async () =>
      clusterCalls[0].resolve(
        list(card("person-1", "Alex", 5), card("person-2", "Bo", 4), card("person-3", "Cy", 3)),
      ),
    );

    fireEvent.contextMenu(screen.getByText("5 faces"));
    fireEvent.contextMenu(screen.getByText("4 faces"));
    fireEvent.click(screen.getByRole("button", { name: "Merge 2 people" }));
    // The merge is done and its refresh of the list is in flight.
    await waitFor(() => expect(clusterCalls).toHaveLength(2));

    await changeFilter(view, NARROW);
    expect(clusterCalls).toHaveLength(3);
    await act(async () => clusterCalls[2].resolve(list(card("person-4", "Di", 7))));
    expect(screen.getByText("7 faces")).toBeInTheDocument();

    await act(async () =>
      clusterCalls[1].resolve(list(card("person-1", "Alex", 9), card("person-3", "Cy", 3))),
    );
    expect(screen.getByText("7 faces")).toBeInTheDocument();
    expect(screen.queryByText("9 faces")).not.toBeInTheDocument();
  });

  it("forgets people picked for merging once the filter hides them", async () => {
    const view = render(<PeopleViewHarness />);
    await act(async () =>
      clusterCalls[0].resolve(list(card("person-1", "Alex", 5), card("person-2", "Bo", 4))),
    );

    fireEvent.contextMenu(screen.getByText("5 faces"));
    fireEvent.contextMenu(screen.getByText("4 faces"));
    expect(screen.getByRole("button", { name: "Merge 2 people" })).toBeInTheDocument();

    await changeFilter(view, NARROW);
    await act(async () => clusterCalls[1].resolve(list(card("person-1", "Alex", 2))));

    expect(screen.queryByRole("button", { name: /Merge \d+ people/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });
});
