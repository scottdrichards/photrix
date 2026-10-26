import { describe, expect, it } from "vitest";
import { formatClock, videoPeople } from "./videoPeople";
import type { PhotoPersonFace } from "../api/types";

const face = (
  personId: string,
  appearances: Array<[number, number]>,
  name: string | null = null,
): PhotoPersonFace => ({
  faceId: Math.random(),
  box: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 },
  personId,
  name,
  frameTimeMs: appearances[0]?.[0],
  appearances: appearances.map(([startMs, endMs]) => ({ startMs, endMs })),
});

describe("videoPeople", () => {
  it("pools one person's faces and finds their first and longest stretch", () => {
    const [ada, bo] = videoPeople([
      face("person-2", [[5_000, 6_000]], "Bo"),
      face(
        "person-1",
        [
          [1_000, 2_000],
          [10_000, 30_000],
        ],
        "Ada",
      ),
      face("person-1", [[29_000, 31_000]]),
    ]);
    expect(ada.name).toBe("Ada");
    expect(ada.appearances).toEqual([
      { startMs: 1_000, endMs: 2_000 },
      { startMs: 10_000, endMs: 31_000 },
    ]);
    expect(ada.first).toEqual({ startMs: 1_000, endMs: 2_000 });
    expect(ada.longest).toEqual({ startMs: 10_000, endMs: 31_000 });
    expect(ada.totalMs).toBe(22_000);
    expect(bo.personId).toBe("person-2");
  });

  it("falls back to the face's frame, and skips faces with no time at all", () => {
    const people = videoPeople([
      { ...face("person-1", []), frameTimeMs: 4_000, appearances: undefined },
      { ...face("person-2", []), frameTimeMs: undefined, appearances: undefined },
    ]);
    expect(people).toHaveLength(1);
    expect(people[0].first).toEqual({ startMs: 4_000, endMs: 4_000 });
  });
});

describe("formatClock", () => {
  it("formats minutes and hours", () => {
    expect(formatClock(7_000)).toBe("0:07");
    expect(formatClock(3_725_000)).toBe("1:02:05");
  });
});
