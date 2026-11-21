import type { StoryDetail, StoryFrame } from "../../api/stories";
import {
  fitFor,
  kenBurns,
  nearestRoutePoint,
  projectRoute,
  slidesOf,
} from "./storyMotion";

const frame = (path: string, day: number): StoryFrame => ({
  path,
  localTime: `2023-05-0${2 + day}T12:00:00`,
  day,
  width: 1200,
  height: 800,
  lat: null,
  lon: null,
  place: null,
  faces: [],
});

const story = (frames: StoryFrame[]): Pick<StoryDetail, "frames" | "chapters"> => {
  const chapters = frames.flatMap((f, i) =>
    i === 0 || frames[i - 1].day !== f.day
      ? [{ day: f.day, date: f.localTime.slice(0, 10), place: null, firstFrame: i }]
      : [],
  );
  return { frames, chapters };
};

describe("slidesOf", () => {
  it("opens with the title, puts a chapter card before each new day, and ends on the end card", () => {
    const slides = slidesOf(story([frame("a", 1), frame("b", 1), frame("c", 2)]));
    expect(
      slides.map((slide) =>
        slide.kind === "photo"
          ? slide.frame.path
          : slide.kind === "chapter"
            ? `day ${slide.chapter.day}`
            : slide.kind,
      ),
    ).toEqual(["title", "day 1", "a", "b", "day 2", "c", "end"]);
  });

  it("skips chapter cards for a single-day story", () => {
    expect(
      slidesOf(story([frame("a", 1), frame("b", 1)])).map(({ kind }) => kind),
    ).toEqual(["title", "photo", "photo", "end"]);
  });
});

describe("fitFor", () => {
  it("fills the screen with a photo of about its shape and letterboxes one that differs", () => {
    expect(fitFor(3 / 2, 16 / 9)).toBe("cover");
    expect(fitFor(2 / 3, 16 / 9)).toBe("contain");
    expect(fitFor(9 / 16, 9 / 19.5)).toBe("cover");
  });
});

describe("kenBurns", () => {
  it("pushes in toward faces, without ever showing past the photo's edge", () => {
    const faces = [{ x: 0.7, y: 0.2, width: 0.1, height: 0.15 }];
    const { from, to } = kenBurns(faces, 0, "cover");
    expect(to.scale).toBeGreaterThan(from.scale);
    // The faces are right of and above centre, so the photo moves left and down.
    expect(to.x).toBeLessThan(0);
    expect(to.y).toBeGreaterThan(0);
    for (const pose of [from, to]) {
      const limit = ((pose.scale - 1) / 2) * 100 + 1e-9;
      expect(Math.abs(pose.x)).toBeLessThanOrEqual(limit);
      expect(Math.abs(pose.y)).toBeLessThanOrEqual(limit);
    }
  });

  it("zooms tighter on a small face than on a group", () => {
    const small = kenBurns([{ x: 0.45, y: 0.3, width: 0.05, height: 0.07 }], 0, "cover");
    const group = kenBurns(
      [
        { x: 0.1, y: 0.3, width: 0.1, height: 0.15 },
        { x: 0.7, y: 0.35, width: 0.1, height: 0.15 },
      ],
      0,
      "cover",
    );
    expect(small.to.scale).toBeGreaterThan(group.to.scale);
  });

  it("alternates pushing in and pulling out on photos without faces", () => {
    const even = kenBurns([], 2, "cover");
    const odd = kenBurns([], 3, "cover");
    expect(even.to.scale).toBeGreaterThan(even.from.scale);
    expect(odd.to.scale).toBeLessThan(odd.from.scale);
  });

  it("moves a letterboxed photo only gently", () => {
    const { to } = kenBurns(
      [{ x: 0.4, y: 0.3, width: 0.05, height: 0.07 }],
      0,
      "contain",
    );
    expect(to.scale).toBeLessThanOrEqual(1.08);
  });
});

describe("projectRoute", () => {
  const route = [
    { lat: 41.89, lon: 12.49 }, // Rome
    { lat: 43.77, lon: 11.26 }, // Florence, north-west
  ];

  it("fits the route inside the padded box, north up", () => {
    const { points } = projectRoute(route, 200, 100, 10);
    for (const [x, y] of points) {
      expect(x).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(x).toBeLessThanOrEqual(190 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(y).toBeLessThanOrEqual(90 + 1e-9);
    }
    const [rome, florence] = points;
    expect(florence[1]).toBeLessThan(rome[1]);
    expect(florence[0]).toBeLessThan(rome[0]);
  });

  it("copes with a route that never leaves one spot", () => {
    const { points } = projectRoute([route[0], route[0]], 200, 100, 10);
    expect(points[0]).toEqual([100, 50]);
  });
});

describe("nearestRoutePoint", () => {
  it("finds where along the route a photo was taken", () => {
    const route = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
      { lat: 0, lon: 2 },
    ];
    expect(nearestRoutePoint(route, 0.1, 1.2)).toBe(1);
  });
});
