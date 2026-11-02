import {
  CHECK_INTERVAL_MS,
  MIN_CHECK_GAP_MS,
  RESUME_AFTER_HIDDEN_MS,
  entryScriptFromHtml,
  watchForAppUpdate,
} from "./appUpdate";

const BUILT_HTML = (hash: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="/assets/index-${hash}.js"></script></head><body><div id="root"></div></body></html>`;

const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("entryScriptFromHtml", () => {
  it("reads the built entry script", () => {
    expect(entryScriptFromHtml(BUILT_HTML("abc123"))).toBe("/assets/index-abc123.js");
  });

  it("returns null for a page with no module script", () => {
    expect(entryScriptFromHtml("<html><body>maintenance</body></html>")).toBeNull();
  });
});

describe("watchForAppUpdate", () => {
  let script: HTMLScriptElement;
  let clock: number;
  let stop: () => void = () => {};

  beforeEach(() => {
    clock = 1_000_000;
    script = document.createElement("script");
    script.type = "module";
    script.setAttribute("src", "/assets/index-old.js");
    document.head.appendChild(script);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  afterEach(() => {
    stop();
    script.remove();
    (document.activeElement as HTMLElement | null)?.blur?.();
    vi.useRealTimers();
  });

  const start = (latest: string | null) => {
    const reload = vi.fn();
    const onUpdateAvailable = vi.fn();
    const latestEntryScript = vi.fn().mockResolvedValue(latest);
    stop = watchForAppUpdate({ onUpdateAvailable, reload, latestEntryScript, now: () => clock });
    return { reload, onUpdateAvailable, latestEntryScript };
  };

  it("reloads when the app comes back after a while and a new build is out", async () => {
    const { reload, onUpdateAvailable } = start("/assets/index-new.js");
    setVisibility("hidden");
    clock += RESUME_AFTER_HIDDEN_MS + 1;
    setVisibility("visible");
    await flush();
    expect(reload).toHaveBeenCalledOnce();
    expect(onUpdateAvailable).not.toHaveBeenCalled();
  });

  it("does nothing on resume when the build is unchanged", async () => {
    const { reload, onUpdateAvailable, latestEntryScript } = start("/assets/index-old.js");
    setVisibility("hidden");
    clock += RESUME_AFTER_HIDDEN_MS + 1;
    setVisibility("visible");
    await flush();
    expect(latestEntryScript).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(onUpdateAvailable).not.toHaveBeenCalled();
  });

  it("only offers the update when the user is typing", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.value = "half a tag";
    input.focus();
    const { reload, onUpdateAvailable } = start("/assets/index-new.js");
    setVisibility("hidden");
    clock += RESUME_AFTER_HIDDEN_MS + 1;
    setVisibility("visible");
    await flush();
    expect(reload).not.toHaveBeenCalled();
    expect(onUpdateAvailable).toHaveBeenCalledOnce();
    input.remove();
  });

  it("still reloads when the focused field is empty", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const { reload } = start("/assets/index-new.js");
    setVisibility("hidden");
    clock += RESUME_AFTER_HIDDEN_MS + 1;
    setVisibility("visible");
    await flush();
    expect(reload).toHaveBeenCalledOnce();
    input.remove();
  });

  it("offers, rather than forces, an update found while the app is in use", async () => {
    vi.useFakeTimers();
    const { reload, onUpdateAvailable } = start("/assets/index-new.js");
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(reload).not.toHaveBeenCalled();
    expect(onUpdateAvailable).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    expect(onUpdateAvailable).toHaveBeenCalledOnce();
  });

  it("treats a quick app switch as use, not a return", async () => {
    const { reload, onUpdateAvailable } = start("/assets/index-new.js");
    clock += MIN_CHECK_GAP_MS + 1;
    setVisibility("hidden");
    clock += 1_000;
    setVisibility("visible");
    await flush();
    expect(reload).not.toHaveBeenCalled();
    expect(onUpdateAvailable).toHaveBeenCalledOnce();
  });

  it("ignores a failed check", async () => {
    const { reload, onUpdateAvailable } = start(null);
    setVisibility("hidden");
    clock += RESUME_AFTER_HIDDEN_MS + 1;
    setVisibility("visible");
    await flush();
    expect(reload).not.toHaveBeenCalled();
    expect(onUpdateAvailable).not.toHaveBeenCalled();
  });

  it("stays off under the dev server, whose entry never changes name", async () => {
    script.setAttribute("src", "/src/main.tsx");
    const { latestEntryScript } = start("/assets/index-new.js");
    setVisibility("hidden");
    clock += RESUME_AFTER_HIDDEN_MS + 1;
    setVisibility("visible");
    await flush();
    expect(latestEntryScript).not.toHaveBeenCalled();
  });
});
