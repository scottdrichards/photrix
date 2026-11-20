import type { StoryBox, StoryChapter, StoryDetail, StoryFrame } from "../../api/stories";

export type Slide =
  | { kind: "title" }
  | { kind: "chapter"; chapter: StoryChapter; next: StoryFrame }
  | { kind: "photo"; frame: StoryFrame; index: number }
  | { kind: "end" };

/** How long each slide holds, in ms. The end card waits for the viewer. */
export const SLIDE_MS = {
  title: 4800,
  chapter: 2800,
  photo: 5200,
  end: Infinity,
} as const;

/** Title, then each frame, a chapter card before each new day of a multi-day story, then the end card. */
export const slidesOf = (story: Pick<StoryDetail, "frames" | "chapters">): Slide[] => {
  const chapterAt = new Map(
    story.chapters.map((chapter) => [chapter.firstFrame, chapter]),
  );
  return [
    { kind: "title" },
    ...story.frames.flatMap((frame, index): Slide[] => {
      const chapter = story.chapters.length > 1 ? chapterAt.get(index) : undefined;
      return chapter
        ? [
            { kind: "chapter", chapter, next: frame },
            { kind: "photo", frame, index },
          ]
        : [{ kind: "photo", frame, index }];
    }),
    { kind: "end" },
  ];
};

/** A CSS transform: `translate(x%, y%) scale(scale)`, origin at the centre. */
export type Pose = { scale: number; x: number; y: number };

/** Shown whole on a blurred backdrop when the photo and screen shapes differ this much; else it fills the screen. */
export const fitFor = (imageAspect: number, screenAspect: number): "cover" | "contain" =>
  Math.max(imageAspect / screenAspect, screenAspect / imageAspect) > 1.3
    ? "contain"
    : "cover";

/** Rule-of-thirds resting points for a photo with no faces, picked by seed. */
const RESTING_POINTS = [
  { x: 0.5, y: 0.45 },
  { x: 0.38, y: 0.42 },
  { x: 0.62, y: 0.42 },
  { x: 0.5, y: 0.58 },
];

const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

/** The pose at `scale` that brings `focus` (0..1 of the image) as near the centre as the image edges allow. */
const poseToward = (
  focus: { x: number; y: number },
  scale: number,
  strength = 1,
): Pose => {
  const limit = ((scale - 1) / 2) * 100;
  return {
    scale,
    x: clamp((0.5 - focus.x) * 100 * scale * strength, limit),
    y: clamp((0.5 - focus.y) * 100 * scale * strength, limit),
  };
};

/**
 * The Ken Burns move for a frame: a slow push in on the faces (tighter for
 * small faces), or on a photo without faces a push in or pull out around a
 * thirds point, alternating by seed. A contained photo moves less, since its
 * edges are on screen.
 */
export const kenBurns = (
  faces: StoryBox[],
  seed: number,
  fit: "cover" | "contain",
): { from: Pose; to: Pose } => {
  const union = faces.length
    ? faces.reduce(
        (box, face) => ({
          left: Math.min(box.left, face.x),
          top: Math.min(box.top, face.y),
          right: Math.max(box.right, face.x + face.width),
          bottom: Math.max(box.bottom, face.y + face.height),
        }),
        { left: 1, top: 1, right: 0, bottom: 0 },
      )
    : null;
  const focus = union
    ? { x: (union.left + union.right) / 2, y: (union.top + union.bottom) / 2 }
    : RESTING_POINTS[seed % RESTING_POINTS.length];
  const span = union ? Math.max(union.right - union.left, union.bottom - union.top) : 0.5;
  const near = fit === "contain" ? 1.08 : Math.min(1.32, Math.max(1.14, 0.42 / span));
  const wide = fit === "contain" ? 1 : 1.04;
  const close = poseToward(focus, near);
  const far = poseToward({ x: 1 - focus.x, y: 1 - focus.y }, wide, 0.5);
  return union || seed % 2 === 0 ? { from: far, to: close } : { from: close, to: far };
};

export const poseTransform = ({ scale, x, y }: Pose) =>
  `translate(${x.toFixed(2)}%, ${y.toFixed(2)}%) scale(${scale.toFixed(3)})`;

/**
 * Projects a route into a width x height box (equirectangular, longitude
 * shrunk by the cosine of the mid latitude), centred and padded. Returns the
 * projected points and the projection for any other fix.
 */
export const projectRoute = (
  route: Array<{ lat: number; lon: number }>,
  width: number,
  height: number,
  pad: number,
) => {
  const lats = route.map(({ lat }) => lat);
  const lons = route.map(({ lon }) => lon);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const squeeze = Math.cos((midLat * Math.PI) / 180);
  // A route inside one town still gets a sensible scale.
  const spanX = Math.max(0.02, (Math.max(...lons) - Math.min(...lons)) * squeeze);
  const spanY = Math.max(0.02, Math.max(...lats) - Math.min(...lats));
  const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
  const centreX = ((Math.min(...lons) + Math.max(...lons)) / 2) * squeeze;
  const centreY = (Math.min(...lats) + Math.max(...lats)) / 2;
  const project = (lat: number, lon: number): [number, number] => [
    width / 2 + (lon * squeeze - centreX) * scale,
    height / 2 - (lat - centreY) * scale,
  ];
  return { points: route.map(({ lat, lon }) => project(lat, lon)), project };
};

/** Index of the route point nearest a fix, so the travelled part of the route can be drawn. */
export const nearestRoutePoint = (
  route: Array<{ lat: number; lon: number }>,
  lat: number,
  lon: number,
) =>
  route.reduce(
    (best, point, index) => {
      const distance = (point.lat - lat) ** 2 + (point.lon - lon) ** 2;
      return distance < best.distance ? { index, distance } : best;
    },
    { index: 0, distance: Infinity },
  ).index;
