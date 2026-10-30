import { act, fireEvent, render, screen } from "@testing-library/react";
import type { SearchSourceStatus } from "../../api";
import { SearchStatusIcon } from "./SearchStatus";
import { IDLE_SEARCH_ACTIVITY, publishSearchActivity, type SearchActivity } from "./searchActivity";

const fetchSearchStatusMock = vi.fn();

vi.mock("../../api", async () => {
  const actual = await vi.importActual<typeof import("../../api")>("../../api");
  return {
    ...actual,
    fetchSearchStatus: (...args: unknown[]) => fetchSearchStatusMock(...args),
  };
});

const ALL = ["image", "audio", "transcript"] as const;

const publish = (activity: Partial<SearchActivity>) =>
  act(() =>
    publishSearchActivity({
      ...IDLE_SEARCH_ACTIVITY,
      active: true,
      enabledSources: ALL,
      ...activity,
    }),
  );

const icon = () => screen.getByRole("button", { name: /^Search status:/ });

describe("SearchStatusIcon", () => {
  beforeEach(() => {
    fetchSearchStatusMock.mockReset();
    fetchSearchStatusMock.mockResolvedValue({ image: "ready", audio: "ready", transcript: "ready" });
  });

  afterEach(() => {
    act(() => publishSearchActivity(IDLE_SEARCH_ACTIVITY));
  });

  it("renders nothing without an active search", () => {
    render(<SearchStatusIcon />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows progress per source while searching, including a model still loading", async () => {
    fetchSearchStatusMock.mockResolvedValue({ image: "cold", audio: "ready", transcript: "ready" });
    render(<SearchStatusIcon />);
    publish({ searching: true });

    expect(icon()).toHaveAccessibleName("Search status: Searching");
    // One arc per enabled source in the ring.
    expect(icon().querySelectorAll("circle")).toHaveLength(3);

    fireEvent.mouseEnter(icon().parentElement!);
    expect(await screen.findByText("loading model…")).toBeInTheDocument();
    expect(screen.getAllByText("searching…")).toHaveLength(2);
    expect(screen.getByText(/up to 15 s/)).toBeInTheDocument();
  });

  it("only lists the sources the user enabled", () => {
    render(<SearchStatusIcon />);
    publish({ searching: true, enabledSources: ["image"] });
    expect(icon().querySelectorAll("circle")).toHaveLength(1);
    fireEvent.focus(icon());
    expect(screen.getByText("Images")).toBeInTheDocument();
    expect(screen.queryByText("Audio")).not.toBeInTheDocument();
  });

  it("reports every source done, with timings", () => {
    const outcome: SearchSourceStatus = {
      image: { status: "ok", ms: 120 },
      audio: { status: "ok", ms: 1500 },
      transcript: { status: "ok" },
    };
    render(<SearchStatusIcon />);
    publish({ outcome });

    expect(icon()).toHaveAccessibleName("Search status: All sources answered");
    fireEvent.click(icon());
    expect(screen.getByText("done in 120 ms")).toBeInTheDocument();
    expect(screen.getByText("done in 1.5 s")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry/ })).not.toBeInTheDocument();
  });

  it("says a search without a per-source report finished, not that nothing was searched", () => {
    render(<SearchStatusIcon />);
    publish({ outcome: null });
    expect(icon()).toHaveAccessibleName("Search status: Search finished");
    fireEvent.click(icon());
    expect(screen.getAllByText("done")).toHaveLength(3);
    expect(screen.queryByText("not searched")).not.toBeInTheDocument();
  });

  it("warns about a source left out, and highlights Retry once its model is ready", async () => {
    const retry = vi.fn();
    fetchSearchStatusMock.mockResolvedValue({ image: "ready", audio: "ready", transcript: "ready" });
    render(<SearchStatusIcon />);
    publish({
      outcome: {
        image: { status: "failed", reason: "loading" },
        audio: { status: "ok" },
        transcript: { status: "skipped" },
      },
      retry,
    });

    expect(icon()).toHaveAccessibleName("Search status: 1 source left out");
    fireEvent.click(icon());
    expect(screen.getByText("left out: model still loading")).toBeInTheDocument();
    expect(screen.getByText("not searched")).toBeInTheDocument();
    expect(await screen.findByText(/Ready now/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("says a timeout was too slow, and offers Retry without waiting on a model", () => {
    render(<SearchStatusIcon />);
    publish({
      outcome: { image: { status: "failed", reason: "timeout" }, audio: { status: "ok" } },
      enabledSources: ["image", "audio"],
      retry: () => {},
    });
    fireEvent.click(icon());
    expect(screen.getByText("left out: too slow to answer")).toBeInTheDocument();
    expect(screen.getByText("Retry to try again.")).toBeInTheDocument();
    expect(fetchSearchStatusMock).not.toHaveBeenCalled();
  });

  it("opens on hover, and a tap pins it until a second tap or Escape", () => {
    render(<SearchStatusIcon />);
    publish({ outcome: { image: { status: "ok" } } });
    const wrapper = icon().parentElement!;

    fireEvent.mouseEnter(wrapper);
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.mouseLeave(wrapper);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    fireEvent.click(icon());
    fireEvent.mouseLeave(wrapper);
    expect(screen.getByRole("status")).toBeInTheDocument();
    fireEvent.keyDown(icon(), { key: "Escape" });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
