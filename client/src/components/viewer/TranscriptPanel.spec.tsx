import { fireEvent, render, screen } from "@testing-library/react";
import { TranscriptPanel, wordTime } from "./TranscriptPanel";

const segments = [
  { start: 10, end: 20, text: "aaaa bbbb cccc" },
  { start: 30, end: 34, text: "Happy birthday Rachel" },
];

describe("TranscriptPanel", () => {
  it("is collapsed by default", () => {
    const { container } = render(<TranscriptPanel segments={segments} onSeek={vi.fn()} />);
    expect(container.querySelector("details")).not.toHaveAttribute("open");
  });

  it("estimates a word's time from its place in the line", () => {
    expect(wordTime(segments[0], 0)).toBe(10);
    expect(wordTime(segments[0], 7)).toBeCloseTo(10 + (10 * 7) / 14);
  });

  it("seeks to the clicked word", () => {
    const onSeek = vi.fn();
    render(<TranscriptPanel segments={segments} onSeek={onSeek} />);
    fireEvent.click(screen.getByRole("button", { name: "aaaa" }));
    expect(onSeek).toHaveBeenCalledWith(10);
    fireEvent.click(screen.getByRole("button", { name: "Play from 0:30" }));
    expect(onSeek).toHaveBeenLastCalledWith(30);
  });

  it("narrows to matching lines when searched", () => {
    render(<TranscriptPanel segments={segments} onSeek={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search transcript" }), {
      target: { value: "rachel" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("1 line");
    expect(screen.queryByRole("button", { name: "aaaa" })).toBeNull();
  });
});
