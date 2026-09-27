import { render, screen } from "@testing-library/react";
import { SearchStatus } from "./SearchStatus";

const fetchSearchStatusMock = vi.fn();

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    fetchSearchStatus: (...args: unknown[]) => fetchSearchStatusMock(...args),
  };
});

const ALL = ["image", "audio", "transcript"] as const;

describe("SearchStatus", () => {
  beforeEach(() => {
    fetchSearchStatusMock.mockReset();
  });

  it("shows which sources are loading a model while a search runs", async () => {
    fetchSearchStatusMock.mockResolvedValue({
      image: "cold",
      audio: "ready",
      transcript: "ready",
    });
    render(
      <SearchStatus searching outcome={null} enabledSources={ALL} onRetry={() => {}} />,
    );

    expect(await screen.findByText(/Images: loading model/)).toBeInTheDocument();
    expect(screen.getByText(/Audio: searching/)).toBeInTheDocument();
    expect(screen.getByText(/Transcripts: searching/)).toBeInTheDocument();
    expect(screen.getByText(/up to 15 s/)).toBeInTheDocument();
  });

  it("only lists the sources the user enabled", async () => {
    fetchSearchStatusMock.mockResolvedValue({
      image: "ready",
      audio: "ready",
      transcript: "ready",
    });
    render(
      <SearchStatus
        searching
        outcome={null}
        enabledSources={["image"]}
        onRetry={() => {}}
      />,
    );

    expect(await screen.findByText(/Images: searching/)).toBeInTheDocument();
    expect(screen.queryByText(/Audio/)).not.toBeInTheDocument();
    expect(screen.queryByText(/up to 15 s/)).not.toBeInTheDocument();
  });

  it("renders nothing after a search where every source answered", () => {
    const { container } = render(
      <SearchStatus
        searching={false}
        outcome={{ image: { status: "ok" }, audio: { status: "ok" } }}
        enabledSources={ALL}
        onRetry={() => {}}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(fetchSearchStatusMock).not.toHaveBeenCalled();
  });

  it("names a slow warm model as too slow, without waiting for a load", () => {
    render(
      <SearchStatus
        searching={false}
        outcome={{ image: { status: "failed", reason: "timeout" } }}
        enabledSources={ALL}
        onRetry={() => {}}
      />,
    );
    expect(screen.getByText(/took too long to answer/)).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for the model/)).not.toBeInTheDocument();
    expect(fetchSearchStatusMock).not.toHaveBeenCalled();
  });
});
