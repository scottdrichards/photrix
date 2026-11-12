import { Suspense } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { lazyPart, RELOAD_GAP_MS } from "./lazyPart";

vi.mock("./logFailure", () => ({ logFailure: () => () => undefined }));

const Hello = ({ name }: { name: string }) => <p>hello {name}</p>;

const show = (Part: React.ComponentType<{ name: string }>) =>
  render(
    <Suspense fallback={<p>loading</p>}>
      <Part name="there" />
    </Suspense>,
  );

describe("lazyPart", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders the part once it has loaded", async () => {
    const { Part } = lazyPart("test", () => Promise.resolve(Hello));
    show(Part);
    expect(screen.getByText("loading")).toBeInTheDocument();
    expect(await screen.findByText("hello there")).toBeInTheDocument();
  });

  it("loads once, however often it is preloaded and rendered", async () => {
    const load = vi.fn(() => Promise.resolve(Hello));
    const { Part, preload } = lazyPart("test", load);
    preload();
    preload();
    show(Part);
    await screen.findByText("hello there");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reloads the page when the part can no longer be fetched", async () => {
    const reload = vi.fn();
    const { Part } = lazyPart("test", () => Promise.reject(new Error("404")), { reload });
    show(Part);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    // Still suspended while the reload is on its way.
    expect(screen.getByText("loading")).toBeInTheDocument();
  });

  it("does not reload again when the part still fails right after a reload", async () => {
    const reload = vi.fn();
    const clock = { now: 1_000_000 };
    const options = { reload, now: () => clock.now };
    const failing = () => Promise.reject(new Error("offline"));

    const first = show(lazyPart("test", failing, options).Part);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    first.unmount();

    // The reloaded page hits the same failure a moment later: render nothing.
    clock.now += 5_000;
    const second = show(lazyPart("test", failing, options).Part);
    await waitFor(() => expect(screen.queryByText("loading")).not.toBeInTheDocument());
    expect(reload).toHaveBeenCalledTimes(1);
    second.unmount();

    // Much later it is a stale page again, and a reload is the cure.
    clock.now += RELOAD_GAP_MS;
    show(lazyPart("test", failing, options).Part);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
  });

  it("leaves a failed preload for the first real use, which tries again", async () => {
    const reload = vi.fn();
    const load = vi
      .fn<() => Promise<typeof Hello>>()
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValue(Hello);
    const { Part, preload } = lazyPart("test", load, { reload });
    await act(async () => {
      preload();
      await Promise.resolve();
    });
    show(Part);
    expect(await screen.findByText("hello there")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(2);
  });
});
