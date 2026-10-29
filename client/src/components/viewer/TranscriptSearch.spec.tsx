import { fireEvent, render, screen } from "@testing-library/react";
import { findInTranscript, TranscriptSearch } from "./TranscriptSearch";

const segments = [
  { start: 75, end: 79, text: "and then Rachel came around the corner" },
  { start: 3, end: 6, text: "Happy birthday!" },
  { start: 412, end: 415, text: "Is that RACHEL on the bike?" },
  { start: 500, end: 503, text: "Zoë, over here" },
];

describe("findInTranscript (feedback #169)", () => {
  it("finds every caption saying the text, case-insensitively, in playback order", () => {
    expect(findInTranscript(segments, "rachel").map((s) => s.start)).toEqual([75, 412]);
  });

  it("ignores accents", () => {
    expect(findInTranscript(segments, "zoe").map((s) => s.start)).toEqual([500]);
  });

  it("waits for two characters", () => {
    expect(findInTranscript(segments, " r ")).toEqual([]);
  });
});

describe("TranscriptSearch (feedback #169)", () => {
  it("lists the places a name is said and seeks to the one picked", () => {
    const onSeek = vi.fn();
    render(<TranscriptSearch segments={segments} onSeek={onSeek} onClose={vi.fn()} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Find in captions" }), {
      target: { value: "Rachel" },
    });

    expect(screen.getByRole("status")).toHaveTextContent("2 places");
    const results = screen.getAllByRole("button", { name: /rachel/i });
    expect(results[0]).toHaveTextContent("1:15");
    expect(results[1]).toHaveTextContent("6:52");
    expect(results[1].querySelector("mark")).toHaveTextContent("RACHEL");

    fireEvent.click(results[1]);
    expect(onSeek).toHaveBeenCalledWith(412);
  });

  it("says when nothing matches", () => {
    render(<TranscriptSearch segments={segments} onSeek={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Find in captions" }), {
      target: { value: "gandalf" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Not said in this video");
  });

  it("keeps Escape and the arrow keys from reaching the viewer", () => {
    const onClose = vi.fn();
    const viewerKeys = vi.fn();
    window.addEventListener("keydown", viewerKeys);
    render(<TranscriptSearch segments={segments} onSeek={vi.fn()} onClose={onClose} />);
    const box = screen.getByRole("searchbox", { name: "Find in captions" });

    fireEvent.keyDown(box, { key: "ArrowLeft" });
    fireEvent.keyDown(box, { key: "Escape" });

    expect(viewerKeys).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    window.removeEventListener("keydown", viewerKeys);
  });
});
