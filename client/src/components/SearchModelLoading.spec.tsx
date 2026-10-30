import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchStatusDetail } from "../api";

const fetchSearchStatusDetailMock = vi.fn<() => Promise<SearchStatusDetail>>();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, fetchSearchStatusDetail: () => fetchSearchStatusDetailMock() };
});

const { SearchModelLoading } = await import("./SearchModelLoading");

const imageLoading = {
  image: { status: "failed", reason: "loading" },
  audio: { status: "ok" },
  transcript: { status: "ok" },
} as const;

const status = (
  image: SearchStatusDetail["sources"]["image"],
  loads: SearchStatusDetail["loads"] = {},
): SearchStatusDetail => ({
  sources: { image, audio: "ready", transcript: "ready" },
  loads,
});

beforeEach(() => {
  fetchSearchStatusDetailMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SearchModelLoading (feedback #162)", () => {
  it("says which model, how long it has loaded and how long it took last time", async () => {
    fetchSearchStatusDetailMock.mockResolvedValue(
      status("loading", { image: { loadingForMs: 12_000, lastLoadMs: 38_000 } }),
    );
    render(<SearchModelLoading outcome={imageLoading} onRetry={vi.fn()} />);

    expect(screen.getByText("Search is waiting for the photo search model to load.")).toBeInTheDocument();
    expect(await screen.findByText(/Loading for 12 s; last time it took 38 s/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Loading the photo search model" })).toHaveAttribute(
      "value",
      String(12 / 38),
    );
  });

  it("runs the search again by itself once the model is ready, once", async () => {
    fetchSearchStatusDetailMock
      .mockResolvedValueOnce(status("loading", { image: { loadingForMs: 1_000 } }))
      .mockResolvedValue(status("ready", { image: { lastLoadMs: 2_000 } }));
    const onRetry = vi.fn();
    render(<SearchModelLoading outcome={imageLoading} onRetry={onRetry} />);

    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("counts the user's whole wait when a worker restart resets the server's timer", async () => {
    vi.useFakeTimers();
    fetchSearchStatusDetailMock.mockResolvedValue(
      status("loading", { image: { loadingForMs: 5_000 } }),
    );
    render(<SearchModelLoading outcome={imageLoading} onRetry={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screen.getByText(/Loading for 60 s/)).toBeInTheDocument();
  });

  it("says when the model isn't loading at all", async () => {
    fetchSearchStatusDetailMock.mockResolvedValue(status("cold"));
    render(<SearchModelLoading outcome={imageLoading} onRetry={vi.fn()} />);

    expect(await screen.findByText(/isn.t loading right now/)).toBeInTheDocument();
  });

  it("stops promising results after three minutes", async () => {
    vi.useFakeTimers();
    fetchSearchStatusDetailMock.mockResolvedValue(status("loading", { image: { loadingForMs: 5_000 } }));
    render(<SearchModelLoading outcome={imageLoading} onRetry={vi.fn()} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 60_000);
    });
    expect(screen.getByText(/Still not ready after 3 minutes/)).toBeInTheDocument();
  });

  it("offers a plain retry when a source failed for another reason", () => {
    render(
      <SearchModelLoading
        outcome={{ image: { status: "failed", reason: "timeout" } }}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText(/a source failed or was too slow/)).toBeInTheDocument();
    expect(fetchSearchStatusDetailMock).not.toHaveBeenCalled();
  });
});
