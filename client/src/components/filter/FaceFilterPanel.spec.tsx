import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { FaceAttributeFilter } from "../../../../shared/filter-contract/src";
import { FaceFilterPanel } from "./FaceFilterPanel";
import { FilterProvider, useFilter } from "./FilterContext";

// vi.mock factories are hoisted above top-level const declarations, so the
// mock fn has to be created inside vi.hoisted rather than referenced from a
// plain module-scope const.
const { fetchStatusMock } = vi.hoisted(() => ({
  fetchStatusMock: vi.fn(async () => ({
    backgroundTasks: [] as Array<{
      id: string;
      name: string;
      queue: "background" | "implied";
      state: "queued" | "running" | "paused" | "cancelled" | "complete";
      itemsProcessed?: number;
      total?: number;
      portionComplete?: number;
      description?: string;
    }>,
    maintenance: { backgroundTasksEnabled: true },
  })),
}));

vi.mock("../../api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../../api");
  return {
    ...actual,
    fetchPeopleClusters: vi.fn(async () => ({
      clusters: [],
      totalFaces: 0,
      totalClusters: 0,
      pendingFaces: 0,
    })),
    buildFaceCropUrl: () => "/crop.jpg",
    fetchStatus: fetchStatusMock,
  };
});

let lastAttributeFilter: FaceAttributeFilter | null | undefined;
let lastClusterFilter: string[] | null | undefined;

const FilterSpy = () => {
  const { filter } = useFilter();
  lastAttributeFilter = filter.faceAttributeFilter;
  lastClusterFilter = filter.faceClusterFilter;
  return null;
};

const renderPanel = (children?: ReactNode) =>
  render(
    <FilterProvider>
      <FaceFilterPanel isActive />
      <FilterSpy />
      {children}
    </FilterProvider>,
  );

const chip = (name: string) => screen.getByRole("button", { name });

describe("FaceFilterPanel attribute controls", () => {
  beforeEach(() => {
    window.history.pushState(null, "", "/");
    lastAttributeFilter = undefined;
    lastClusterFilter = undefined;
    fetchStatusMock.mockClear();
    fetchStatusMock.mockResolvedValue({
      backgroundTasks: [],
      maintenance: { backgroundTasksEnabled: true },
    });
  });

  it("starts with no attribute constraints", async () => {
    renderPanel();
    await waitFor(() => expect(chip("Smiling")).toBeTruthy());

    expect(chip("Smiling").getAttribute("aria-pressed")).toBe("false");
    expect(chip("Photo ready").getAttribute("aria-pressed")).toBe("false");
    expect(lastAttributeFilter).toBeUndefined();
  });

  it("expresses 'smiling with eyes open' as a single filter", async () => {
    renderPanel();
    await waitFor(() => expect(chip("Smiling")).toBeTruthy());

    fireEvent.click(chip("Smiling"));
    fireEvent.click(chip("Eyes open"));

    expect(lastAttributeFilter).toEqual({ attributes: ["smiling", "eyesOpen"] });
  });

  it("keeps attributes in canonical order regardless of click order", async () => {
    renderPanel();
    await waitFor(() => expect(chip("Smiling")).toBeTruthy());

    fireEvent.click(chip("Well exposed"));
    fireEvent.click(chip("Smiling"));

    expect(lastAttributeFilter).toEqual({ attributes: ["smiling", "wellExposed"] });
  });

  it("toggles an attribute back off", async () => {
    renderPanel();
    await waitFor(() => expect(chip("Smiling")).toBeTruthy());

    fireEvent.click(chip("Smiling"));
    expect(chip("Smiling").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(chip("Smiling"));
    expect(lastAttributeFilter).toBeNull();
  });

  it("'Photo ready' selects all four attributes at once", async () => {
    renderPanel();
    await waitFor(() => expect(chip("Photo ready")).toBeTruthy());

    fireEvent.click(chip("Photo ready"));

    expect(lastAttributeFilter).toEqual({
      attributes: ["smiling", "eyesOpen", "inFocus", "wellExposed"],
    });
    expect(chip("Photo ready").getAttribute("aria-pressed")).toBe("true");
    expect(chip("In focus").getAttribute("aria-pressed")).toBe("true");
  });

  it("'Photo ready' clears everything when it is already fully on", async () => {
    renderPanel();
    await waitFor(() => expect(chip("Photo ready")).toBeTruthy());

    fireEvent.click(chip("Photo ready"));
    fireEvent.click(chip("Photo ready"));

    expect(lastAttributeFilter).toBeNull();
  });

  it("lights 'Photo ready' only once every attribute is on", async () => {
    renderPanel();
    await waitFor(() => expect(chip("Photo ready")).toBeTruthy());

    fireEvent.click(chip("Photo ready"));
    fireEvent.click(chip("In focus"));

    expect(chip("Photo ready").getAttribute("aria-pressed")).toBe("false");
    expect(lastAttributeFilter).toEqual({
      attributes: ["smiling", "eyesOpen", "wellExposed"],
    });
  });

  it("hides the unscored-faces control until an attribute is chosen", async () => {
    renderPanel();
    await waitFor(() => expect(chip("Smiling")).toBeTruthy());

    expect(screen.queryByLabelText(/not yet analysed/i)).toBeNull();

    fireEvent.click(chip("Smiling"));
    expect(screen.getByRole("checkbox")).toBeTruthy();
  });

  it("includes unscored faces by default and excludes them on request", async () => {
    renderPanel();
    await waitFor(() => expect(chip("Smiling")).toBeTruthy());
    fireEvent.click(chip("Smiling"));

    // Default: a face the pipeline has not reached is not treated as a "no".
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(lastAttributeFilter).toEqual({ attributes: ["smiling"] });

    fireEvent.click(checkbox);
    expect(lastAttributeFilter).toEqual({
      attributes: ["smiling"],
      includeUnknown: false,
    });

    fireEvent.click(screen.getByRole("checkbox"));
    expect(lastAttributeFilter).toEqual({ attributes: ["smiling"] });
  });

  it("keeps the strict setting while other attributes are toggled", async () => {
    renderPanel();
    await waitFor(() => expect(chip("Smiling")).toBeTruthy());

    fireEvent.click(chip("Smiling"));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(chip("Eyes open"));

    expect(lastAttributeFilter).toEqual({
      attributes: ["smiling", "eyesOpen"],
      includeUnknown: false,
    });
  });

  it("Clear resets both the people and the attribute selection", async () => {
    renderPanel();
    await waitFor(() => expect(chip("Smiling")).toBeTruthy());

    fireEvent.click(chip("Photo ready"));
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(lastAttributeFilter).toBeNull();
    expect(lastClusterFilter).toBeNull();
  });

  it("offers no Clear button when nothing is selected", async () => {
    renderPanel();
    await waitFor(() => expect(chip("Smiling")).toBeTruthy());

    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("does not claim background scoring is happening when the backfill has no backlog", async () => {
    // /api/status omits the backfill task entirely once it has drained (see
    // registerBackgroundTasks.ts's reentrant wrapper), so an empty
    // backgroundTasks list is the real "nothing left to score" signal.
    fetchStatusMock.mockResolvedValue({
      backgroundTasks: [],
      maintenance: { backgroundTasksEnabled: true },
    });
    renderPanel();
    await waitFor(() => expect(chip("Smiling")).toBeTruthy());

    fireEvent.click(chip("Smiling"));
    await waitFor(() => expect(fetchStatusMock).toHaveBeenCalled());

    expect(
      screen.queryByText(/still need scoring in the background/i),
    ).toBeNull();
    expect(
      await screen.findByText(/counts as a match by default/i),
    ).toBeTruthy();
  });

  it("shows the remaining count when the backfill task reports an active backlog", async () => {
    fetchStatusMock.mockResolvedValue({
      backgroundTasks: [
        {
          id: "background:Face attributes (photo ready)",
          name: "Face attributes (photo ready)",
          queue: "background",
          state: "running",
          itemsProcessed: 300_000,
          total: 360_511,
        },
      ],
      maintenance: { backgroundTasksEnabled: true },
    });
    renderPanel();
    await waitFor(() => expect(chip("Smiling")).toBeTruthy());

    fireEvent.click(chip("Smiling"));

    expect(await screen.findByText(/60,511 older faces/i)).toBeTruthy();
    expect(screen.getByText(/still need scoring in the background/i)).toBeTruthy();
  });
});
