import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FaceAssignPanel } from "./FaceAssignPanel";
import type { NamedFace } from "./FaceOverlay";

// vi.mock factories are hoisted above top-level const declarations, so the
// mock fns have to be created inside vi.hoisted rather than referenced from a
// plain module-scope const (same pattern as FaceFilterPanel.spec.tsx).
const {
  fetchClusterFacePreviewMock,
  fetchNamedPeopleMock,
  mergeClustersMock,
  renameClusterMock,
} = vi.hoisted(() => ({
  fetchClusterFacePreviewMock: vi.fn(async () => [] as unknown[]),
  fetchNamedPeopleMock: vi.fn(async () => [] as Array<{ id: string; name: string }>),
  mergeClustersMock: vi.fn(async () => undefined),
  renameClusterMock: vi.fn(async () => undefined),
}));

vi.mock("../api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../api");
  return {
    ...actual,
    fetchClusterFacePreview: fetchClusterFacePreviewMock,
    fetchNamedPeople: fetchNamedPeopleMock,
    mergeClusters: mergeClustersMock,
    renameCluster: renameClusterMock,
    buildFaceCropUrl: () => "/crop.jpg",
  };
});

const face: NamedFace = {
  faceId: 42,
  box: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
  personId: "person-7",
  name: null,
};

describe("FaceAssignPanel", () => {
  beforeEach(() => {
    fetchClusterFacePreviewMock.mockClear();
    fetchNamedPeopleMock.mockClear();
    mergeClustersMock.mockClear();
    renameClusterMock.mockClear();
    fetchClusterFacePreviewMock.mockResolvedValue([]);
    fetchNamedPeopleMock.mockResolvedValue([]);
  });

  it("shows related-face thumbnails once the preview loads", async () => {
    fetchClusterFacePreviewMock.mockResolvedValueOnce([
      { photo: { path: "a.jpg", name: "a.jpg" }, box: face.box, faceId: 1 },
      { photo: { path: "b.jpg", name: "b.jpg" }, box: face.box, faceId: 2 },
    ]);

    render(<FaceAssignPanel face={face} onClose={vi.fn()} onAssigned={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getAllByRole("img")).toHaveLength(2);
    });
    expect(fetchClusterFacePreviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ clusterId: "person-7", excludeFaceId: 42 }),
    );
  });

  it("shows a hint instead of thumbnails when there are no other sightings", async () => {
    render(<FaceAssignPanel face={face} onClose={vi.fn()} onAssigned={vi.fn()} />);
    expect(await screen.findByText(/no other photos of this face/i)).toBeInTheDocument();
  });

  it("typing a brand-new name and saving renames the cluster", async () => {
    const onAssigned = vi.fn();
    render(<FaceAssignPanel face={face} onClose={vi.fn()} onAssigned={onAssigned} />);
    await screen.findByText(/no other photos of this face/i);

    fireEvent.change(screen.getByLabelText(/person's name/i), {
      target: { value: "Riley" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(renameClusterMock).toHaveBeenCalledWith("person-7", "Riley"));
    expect(mergeClustersMock).not.toHaveBeenCalled();
    expect(onAssigned).toHaveBeenCalledTimes(1);
  });

  it("typing an existing person's exact name merges into them instead of renaming", async () => {
    fetchNamedPeopleMock.mockResolvedValue([{ id: "person-1", name: "Sarah" }]);
    const onAssigned = vi.fn();
    render(<FaceAssignPanel face={face} onClose={vi.fn()} onAssigned={onAssigned} />);
    await screen.findByText(/no other photos of this face/i);

    fireEvent.change(screen.getByLabelText(/person's name/i), {
      target: { value: "sarah" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(mergeClustersMock).toHaveBeenCalledWith(["person-7"], "person-1"),
    );
    expect(renameClusterMock).not.toHaveBeenCalled();
    expect(onAssigned).toHaveBeenCalledTimes(1);
  });

  it("clicking a suggestion chip merges into that person immediately", async () => {
    fetchNamedPeopleMock.mockResolvedValue([{ id: "person-1", name: "Sarah" }]);
    const onAssigned = vi.fn();
    render(<FaceAssignPanel face={face} onClose={vi.fn()} onAssigned={onAssigned} />);

    // The button's accessible name is its visible text ("Sarah"); the fuller
    // "Assign this face to Sarah" phrasing lives in its `title` tooltip only.
    fireEvent.click(await screen.findByRole("button", { name: "Sarah" }));

    await waitFor(() =>
      expect(mergeClustersMock).toHaveBeenCalledWith(["person-7"], "person-1"),
    );
    expect(onAssigned).toHaveBeenCalledTimes(1);
  });

  it("closing calls onClose without saving anything", async () => {
    const onClose = vi.fn();
    render(<FaceAssignPanel face={face} onClose={onClose} onAssigned={vi.fn()} />);
    await screen.findByText(/no other photos of this face/i);
    fireEvent.click(screen.getByRole("button", { name: /cancel naming this face/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(renameClusterMock).not.toHaveBeenCalled();
    expect(mergeClustersMock).not.toHaveBeenCalled();
  });

  it("shows an inline error and stays open when saving fails", async () => {
    renameClusterMock.mockRejectedValueOnce(new Error("network down"));
    const onAssigned = vi.fn();
    render(<FaceAssignPanel face={face} onClose={vi.fn()} onAssigned={onAssigned} />);
    await screen.findByText(/no other photos of this face/i);

    fireEvent.change(screen.getByLabelText(/person's name/i), {
      target: { value: "Riley" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText(/couldn't save that name/i)).toBeInTheDocument();
    expect(onAssigned).not.toHaveBeenCalled();
  });
});
