/** One dated photo or video, as the story detector sees it. */
export type StoryItem = {
  /** Library-relative path, e.g. "/Trip/Italy/IMG_5101.jpg". */
  path: string;
  /**
   * Capture time, Unix ms. EXIF carries no zone, so it is parsed as the
   * server's local time and the server's local calendar day is the photo's day.
   */
  time: number;
  lat: number | null;
  lon: number | null;
  /** `files.placeText`: "City, State, United States, USA" or "City, Country". */
  place: string | null;
  isVideo: boolean;
  rating: number | null;
  quality: number | null;
  width: number | null;
  height: number | null;
  /** A non-representative member of a burst stack: counted, never shown. */
  burstMember: boolean;
};

export type StoryKind = "trip" | "weekend" | "dayTrip" | "event";

/** A detected run of days, before titles, faces and highlights are added. */
export type StorySpan = {
  id: string;
  kind: StoryKind;
  /** Local calendar days, "YYYY-MM-DD". */
  startDay: string;
  endDay: string;
  dayCount: number;
  /** Sorted by time. */
  items: StoryItem[];
};

export type Box = { x: number; y: number; width: number; height: number };

/** A face in a story photo; boxes are 0..1 of the upright image. */
export type StoryFace = Box & { path: string; name: string | null };

export type StoryPerson = {
  name: string;
  count: number;
  face: { path: string; box: Box } | null;
};

export type StorySummary = {
  id: string;
  kind: StoryKind;
  kicker: string;
  title: string;
  startDay: string;
  endDay: string;
  /** Capture times of the first and last item, Unix ms: the library's date filter for "see all". */
  startTime: number;
  endTime: number;
  dayCount: number;
  photoCount: number;
  videoCount: number;
  /** Most-photographed places first. */
  places: string[];
  /** Ground covered between geotagged photos, rounded; null with no GPS. */
  distanceKm: number | null;
  cover: { path: string; width: number | null; height: number | null };
  /** Up to three more highlight paths for the card collage. */
  collage: string[];
  people: StoryPerson[];
};

export type StoryFrame = {
  path: string;
  /** Wall-clock capture time with no zone, "YYYY-MM-DDTHH:MM:SS". */
  localTime: string;
  /** 1-based day of the story. */
  day: number;
  width: number | null;
  height: number | null;
  lat: number | null;
  lon: number | null;
  place: string | null;
  /** Faces to frame the Ken Burns move around. */
  faces: Array<Box & { name: string | null }>;
};

export type StoryChapter = {
  day: number;
  date: string;
  place: string | null;
  firstFrame: number;
};

export type StoryDetail = StorySummary & {
  frames: StoryFrame[];
  chapters: StoryChapter[];
  route: Array<{ lat: number; lon: number }>;
};
