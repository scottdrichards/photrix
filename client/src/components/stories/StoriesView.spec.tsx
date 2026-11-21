import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import type { StoryDetail, StorySummary } from "../../api/stories";
import { StoriesView } from "./StoriesView";

const summary = (id: string, title: string, startDay: string): StorySummary => ({
  id,
  kind: "trip",
  kicker: "Trip",
  title,
  startDay,
  endDay: startDay,
  startTime: 0,
  endTime: 0,
  dayCount: 1,
  photoCount: 5,
  videoCount: 0,
  places: [],
  distanceKm: null,
  cover: { path: `/${id}/cover.jpg`, width: 1200, height: 800 },
  collage: [],
  people: [
    {
      name: "Alex",
      count: 3,
      face: { path: `/${id}/a.jpg`, box: { x: 0.4, y: 0.3, width: 0.1, height: 0.1 } },
    },
  ],
});

const rome = summary("trip-2023-05-03-2023-05-06", "Rome & Florence", "2023-05-03");
const detail: StoryDetail = {
  ...rome,
  frames: [
    {
      path: "/Trip/Italy/IMG_5101.jpg",
      localTime: "2023-05-03T14:10:12",
      day: 1,
      width: 1200,
      height: 800,
      lat: 41.89,
      lon: 12.49,
      place: "Rome",
      faces: [{ x: 0.4, y: 0.3, width: 0.1, height: 0.1, name: "Alex" }],
    },
  ],
  chapters: [{ day: 1, date: "2023-05-03", place: "Rome", firstFrame: 0 }],
  route: [
    { lat: 41.89, lon: 12.49 },
    { lat: 43.77, lon: 11.26 },
  ],
};

const respond = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const renderView = (storyId: string | null = null, onOpenStory = vi.fn()) =>
  render(
    <StoriesView
      view="stories"
      onViewChange={vi.fn()}
      storyId={storyId}
      onOpenStory={onOpenStory}
      onShowInLibrary={vi.fn()}
    />,
  );

describe("StoriesView", () => {
  afterEach(() => vi.restoreAllMocks());

  it("features the newest story and groups the rest by year", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      respond({
        stories: [rome, summary("trip-2021-08-01-2021-08-01", "Portland", "2021-08-01")],
      }),
    );
    renderView();
    expect(
      await screen.findByRole("link", { name: /Play story: Rome & Florence/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "2021" })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Play story: Portland/ }),
    ).toBeInTheDocument();
  });

  it("opens a story from its card", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => respond({ stories: [rome] }));
    const onOpenStory = vi.fn();
    renderView(null, onOpenStory);
    fireEvent.click(await screen.findByRole("link", { name: /Rome & Florence/ }));
    expect(onOpenStory).toHaveBeenCalledWith(rome.id);
  });

  it("says why there are no stories in a shared link", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() =>
      respond({ error: "Forbidden" }, 403),
    );
    renderView();
    expect(await screen.findByText(/aren’t part of a shared link/)).toBeInTheDocument();
  });

  it("explains how stories appear when there are none", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => respond({ stories: [] }));
    renderView();
    expect(await screen.findByText(/No stories yet/)).toBeInTheDocument();
  });

  it("plays a story: title card first, and Escape closes it", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      String(input).includes("/api/stories/")
        ? respond(detail)
        : respond({ stories: [rome] }),
    );
    const onOpenStory = vi.fn();
    renderView(rome.id, onOpenStory);
    const player = await screen.findByRole("dialog", { name: "Story: Rome & Florence" });
    expect(player).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 2, name: "Rome & Florence" }),
      ).toBeInTheDocument(),
    );
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(onOpenStory).toHaveBeenCalledWith(null);
  });
});
