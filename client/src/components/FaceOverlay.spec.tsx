import { act, fireEvent, render, screen } from "@testing-library/react";
import { FaceOverlay, type NamedFace } from "./FaceOverlay";

const face: NamedFace = {
  faceId: 7,
  box: { x: 0.5, y: 0.5, width: 0.2, height: 0.2 },
  personId: "p1",
  name: "Alex",
};

describe("FaceOverlay named-face rejection (feedback #145)", () => {
  it("arms on the first click and rejects only on the second", () => {
    const onRejectFace = vi.fn();
    render(
      <FaceOverlay regionsRaw={null} aspectRatio={1} namedFaces={[face]} onRejectFace={onRejectFace} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Not Alex" }));
    expect(onRejectFace).not.toHaveBeenCalled();
    expect(screen.getByText("Not Alex?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm: not Alex" }));
    expect(onRejectFace).toHaveBeenCalledWith(face);
  });

  it("disarms by itself after a few seconds", () => {
    vi.useFakeTimers();
    try {
      const onRejectFace = vi.fn();
      render(
        <FaceOverlay regionsRaw={null} aspectRatio={1} namedFaces={[face]} onRejectFace={onRejectFace} />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Not Alex" }));
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.getByRole("button", { name: "Not Alex" })).toBeInTheDocument();
      expect(onRejectFace).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers no reject control in a read-only view", () => {
    render(<FaceOverlay regionsRaw={null} aspectRatio={1} namedFaces={[face]} />);
    expect(screen.getByText("Alex")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Not Alex" })).toBeNull();
  });
});

describe("FaceOverlay named-face correction (feedback #160)", () => {
  it("opens the assign panel from a named face's name", () => {
    const onAssignFace = vi.fn();
    render(
      <FaceOverlay regionsRaw={null} aspectRatio={1} namedFaces={[face]} onAssignFace={onAssignFace} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Change who this is (Alex)" }));
    expect(onAssignFace).toHaveBeenCalledWith(face);
  });

  it("leaves the name as plain text in a read-only view", () => {
    render(<FaceOverlay regionsRaw={null} aspectRatio={1} namedFaces={[face]} />);
    expect(screen.getByText("Alex").tagName).toBe("SPAN");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
