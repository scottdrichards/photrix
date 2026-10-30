import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AnalysisCoverage, BackgroundTaskStatus } from "../../../shared/filter-contract/src";
import { describeCoverage, StatusCoverage } from "./StatusCoverage";

const videoFaces: AnalysisCoverage = {
  name: "Video faces",
  unit: "videos",
  done: 11086,
  waiting: 0,
  retrying: 234,
  nextRetryAt: new Date(2026, 10, 4, 12).getTime(),
  unreadable: 11,
};

const running: BackgroundTaskStatus = {
  id: "background:Video faces",
  name: "Video faces",
  queue: "background",
  state: "running",
};

describe("StatusCoverage (feedback #158)", () => {
  it("says how far a pass got, what failed and when it retries", () => {
    const text = describeCoverage(videoFaces);
    expect(text).toContain(`${(11086).toLocaleString()} of ${(11331).toLocaleString()} videos done`);
    expect(text).toContain("234 failed, retrying from");
    expect(text).toContain("11 unreadable");
    expect(text).not.toContain("waiting");
  });

  it("names work that is owed but not started", () => {
    expect(describeCoverage({ ...videoFaces, waiting: 5, retrying: 0, unreadable: 0 })).toBe(
      `${(11086).toLocaleString()} of ${(11091).toLocaleString()} videos done · 5 waiting to start`,
    );
  });

  it("lists a pass that is not running", () => {
    render(<StatusCoverage coverage={[videoFaces]} tasks={[]} />);
    expect(screen.getByText("Video faces")).toBeInTheDocument();
  });

  it("leaves a running pass to its own progress bar", () => {
    render(<StatusCoverage coverage={[videoFaces]} tasks={[running]} />);
    expect(screen.queryByTestId("status-coverage")).not.toBeInTheDocument();
  });

  it("renders nothing for a server without coverage", () => {
    render(<StatusCoverage coverage={undefined} tasks={[]} />);
    expect(screen.queryByTestId("status-coverage")).not.toBeInTheDocument();
  });
});
