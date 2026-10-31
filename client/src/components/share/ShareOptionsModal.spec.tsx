import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PhotoItem } from "../../api";
import { ShareOptionsModal } from "./ShareOptionsModal";

const createPhoto = (overrides: Partial<PhotoItem> = {}): PhotoItem => ({
  path: "a/1.heic",
  name: "1.heic",
  mediaType: "photo",
  originalUrl: "http://localhost/api/files/a/1.heic",
  thumbnailUrl: "http://localhost/api/files/a/1.heic?height=320",
  previewUrl: "http://localhost/api/files/a/1.heic?height=2160",
  fullUrl: "http://localhost/api/files/a/1.heic?height=2160",
  ...overrides,
});

describe("ShareOptionsModal", () => {
  const originalFetch = globalThis.fetch;
  const originalCanShare = navigator.canShare;
  const originalShare = navigator.share;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["image"], { type: "image/jpeg" }),
    } as Response);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      writable: true,
      value: originalCanShare,
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      writable: true,
      value: originalShare,
    });
  });

  it("prepares files before invoking the native share sheet", async () => {
    const onClose = vi.fn();
    const shareMock = vi.fn().mockResolvedValue(undefined);

    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      writable: true,
      value: vi.fn(() => true),
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      writable: true,
      value: shareMock,
    });

    render(<ShareOptionsModal photos={[createPhoto()]} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /Smaller size/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    });

    expect(shareMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    await waitFor(() => {
      expect(shareMock).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    const [shareArgs] = shareMock.mock.calls[0] as [{ files: File[] }];
    expect(shareArgs.files).toHaveLength(1);
    expect(shareArgs.files[0]).toBeInstanceOf(File);
    expect(shareArgs.files[0]?.name).toBe("1.jpg");
  });

  it("shares a video as an actual file (not a link) through the native share sheet", async () => {
    const onClose = vi.fn();
    const shareMock = vi.fn().mockResolvedValue(undefined);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["video-bytes"], { type: "video/mp4" }),
    } as Response);

    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      writable: true,
      value: vi.fn(() => true),
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      writable: true,
      value: shareMock,
    });

    const video = createPhoto({
      path: "a/1.mov.mp4",
      name: "1.mov.mp4",
      mediaType: "video",
      originalUrl: "http://localhost/api/files/a/1.mov.mp4",
    });

    render(<ShareOptionsModal photos={[video]} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /Exact video file as stored/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    await waitFor(() => {
      expect(shareMock).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    const [shareArgs] = shareMock.mock.calls[0] as [{ files: File[] }];
    expect(shareArgs.files).toHaveLength(1);
    expect(shareArgs.files[0]).toBeInstanceOf(File);
    expect(shareArgs.files[0]?.name).toBe("1.mov.mp4");
    expect(shareArgs.files[0]?.type).toBe("video/mp4");
  });

  it("falls back to downloading a video when the device can't share files", async () => {
    const onClose = vi.fn();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    Object.defineProperty(navigator, "share", {
      configurable: true,
      writable: true,
      value: undefined,
    });

    const video = createPhoto({
      path: "a/1.mov.mp4",
      name: "1.mov.mp4",
      mediaType: "video",
      originalUrl: "http://localhost/api/files/a/1.mov.mp4",
    });

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    render(<ShareOptionsModal photos={[video]} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /Exact video file as stored/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
    });

    expect(clickSpy).not.toHaveBeenCalled();
    // Never fetched the (potentially huge) video bytes for an unsupported device.
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => {
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("prepares files before triggering the download fallback", async () => {
    const onClose = vi.fn();
    const shareMock = vi.fn();
    const createObjectUrlSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:prepared-file");
    const revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      writable: true,
      value: vi.fn(() => false),
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      writable: true,
      value: shareMock,
    });

    try {
      render(<ShareOptionsModal photos={[createPhoto()]} onClose={onClose} />);

      fireEvent.click(screen.getByRole("button", { name: /Smaller size/i }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
      });

      expect(shareMock).not.toHaveBeenCalled();
      expect(clickSpy).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Download" }));

      await waitFor(() => {
        expect(clickSpy).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
      });

      expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob:prepared-file");
    } finally {
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
      clickSpy.mockRestore();
    }
  });

  it("still offers native share for original HEIC files when canShare says no", async () => {
    const onClose = vi.fn();
    const shareMock = vi.fn().mockResolvedValue(undefined);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["heic"], { type: "image/heic" }),
    } as Response);

    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      writable: true,
      value: vi.fn(() => false),
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      writable: true,
      value: shareMock,
    });

    render(<ShareOptionsModal photos={[createPhoto()]} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /^Original/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Share" }));

    await waitFor(() => {
      expect(shareMock).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    const [shareArgs] = shareMock.mock.calls[0] as [{ files: File[] }];
    expect(shareArgs.files[0]?.name).toBe("1.heic");
  });

  it("falls back to download if sharing an original HEIC file still fails", async () => {
    const onClose = vi.fn();
    const shareMock = vi.fn().mockRejectedValue(new Error("share failed"));
    const createObjectUrlSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:prepared-heic");
    const revokeObjectUrlSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(["heic"], { type: "image/heic" }),
    } as Response);

    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      writable: true,
      value: vi.fn(() => false),
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      writable: true,
      value: shareMock,
    });

    try {
      render(<ShareOptionsModal photos={[createPhoto()]} onClose={onClose} />);

      fireEvent.click(screen.getByRole("button", { name: /^Original/i }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Share" }));

      await waitFor(() => {
        expect(screen.getByText(/ready to download instead/i)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Download" })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole("button", { name: "Download" }));

      await waitFor(() => {
        expect(clickSpy).toHaveBeenCalledTimes(1);
        expect(onClose).toHaveBeenCalledTimes(1);
      });

      expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
      expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob:prepared-heic");
    } finally {
      createObjectUrlSpy.mockRestore();
      revokeObjectUrlSpy.mockRestore();
      clickSpy.mockRestore();
    }
  });

  describe("over the share sheet's limit", () => {
    const setNativeShare = (shareMock: ReturnType<typeof vi.fn>) => {
      Object.defineProperty(navigator, "canShare", { configurable: true, writable: true, value: vi.fn(() => true) });
      Object.defineProperty(navigator, "share", { configurable: true, writable: true, value: shareMock });
    };
    const manyPhotos = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        createPhoto({ path: `a/${i}.heic`, name: `${i}.heic`, originalUrl: `http://localhost/api/files/a/${i}.heic` }),
      );

    it("offers a link instead of fetching more than 10 files", async () => {
      const shareMock = vi.fn();
      setNativeShare(shareMock);
      const fetchMock = vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          json: async () => ({ token: "tok123" }),
          blob: async () => new Blob(["image"], { type: "image/jpeg" }),
          url,
        } as unknown as Response),
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      render(<ShareOptionsModal photos={manyPhotos(12)} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /Smaller size/i }));

      expect(await screen.findByText(/at most 10 files or 50 MB/)).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Share link" }));

      expect(await screen.findByDisplayValue(/tok123/)).toBeInTheDocument();
      expect(shareMock).not.toHaveBeenCalled();
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("/api/auth/share-token");
      const scope = JSON.parse(String(init.body)) as { filter: { relativePath: string[] } };
      expect(scope.filter.relativePath).toEqual(manyPhotos(12).map((photo) => photo.path));
    });

    it("downloads instead when asked, straight from each file's URL", async () => {
      setNativeShare(vi.fn());
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
      const onClose = vi.fn();
      try {
        render(<ShareOptionsModal photos={manyPhotos(11)} onClose={onClose} />);
        fireEvent.click(screen.getByRole("button", { name: /^Original/i }));
        fireEvent.click(await screen.findByRole("button", { name: "Download" }));

        expect(clickSpy).toHaveBeenCalledTimes(11);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        clickSpy.mockRestore();
      }
    });

    it("catches a single original over 50 MB from its stored size", async () => {
      setNativeShare(vi.fn());
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const big = createPhoto({ metadata: { sizeInBytes: 60 * 1024 * 1024 } as PhotoItem["metadata"] });

      render(<ShareOptionsModal photos={[big]} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /^Original/i }));

      expect(await screen.findByRole("button", { name: "Share link" })).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("catches a converted video over 50 MB once it has been fetched", async () => {
      const shareMock = vi.fn();
      setNativeShare(shareMock);
      globalThis.fetch = vi.fn(() =>
        Promise.resolve({
          ok: true,
          blob: async () => new Blob([new Uint8Array(51 * 1024 * 1024)], { type: "video/mp4" }),
        } as Response),
      ) as unknown as typeof fetch;
      const clip = createPhoto({ path: "a/clip.mp4", name: "clip.mp4", mediaType: "video", originalUrl: "http://localhost/api/files/a/clip.mp4" });

      render(<ShareOptionsModal photos={[clip]} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /Smaller size/i }));

      expect(await screen.findByRole("button", { name: "Share link" })).toBeInTheDocument();
      expect(shareMock).not.toHaveBeenCalled();
    });

    it("says so when the link can't be created", async () => {
      setNativeShare(vi.fn());
      globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 403 } as Response)) as unknown as typeof fetch;

      render(<ShareOptionsModal photos={manyPhotos(12)} onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: /Smaller size/i }));
      fireEvent.click(await screen.findByRole("button", { name: "Share link" }));

      expect(await screen.findByText(/Couldn't create a link/)).toBeInTheDocument();
    });
  });

  it("hides the web-safe option for a photo that is already web-safe", () => {
    const photo = createPhoto({
      path: "a/1.jpg",
      name: "1.jpg",
      originalUrl: "http://localhost/api/files/a/1.jpg",
      metadata: { mimeType: "image/jpeg", sizeInBytes: 25 * 1024 * 1024 },
    });

    render(<ShareOptionsModal photos={[photo]} onClose={() => {}} />);

    expect(screen.getByText("Original")).toBeInTheDocument();
    expect(screen.queryByText("Web-safe, original size")).not.toBeInTheDocument();
    // Still large enough that a smaller copy is worth offering.
    expect(screen.getByText("Smaller size")).toBeInTheDocument();
  });

  it("hides the smaller-size option for a photo already under 20MB", () => {
    const photo = createPhoto({
      path: "a/1.heic",
      name: "1.heic",
      metadata: { mimeType: "image/heic", sizeInBytes: 5 * 1024 * 1024 },
    });

    render(<ShareOptionsModal photos={[photo]} onClose={() => {}} />);

    expect(screen.getByText("Original")).toBeInTheDocument();
    // Still HEIC, so a web-safe copy is still worth offering.
    expect(screen.getByText("Web-safe, original size")).toBeInTheDocument();
    expect(screen.queryByText("Smaller size")).not.toBeInTheDocument();
  });

  it("only shows Original when every photo is already web-safe and small", () => {
    const photo = createPhoto({
      path: "a/1.jpg",
      name: "1.jpg",
      originalUrl: "http://localhost/api/files/a/1.jpg",
      metadata: { mimeType: "image/jpeg", sizeInBytes: 2 * 1024 * 1024 },
    });

    render(<ShareOptionsModal photos={[photo]} onClose={() => {}} />);

    expect(screen.getByText("Original")).toBeInTheDocument();
    expect(screen.queryByText("Web-safe, original size")).not.toBeInTheDocument();
    expect(screen.queryByText("Smaller size")).not.toBeInTheDocument();
  });

  it("keeps both options when a photo's format/size is unknown", () => {
    const photo = createPhoto({
      path: "a/1.jpg",
      name: "1.jpg",
      originalUrl: "http://localhost/api/files/a/1.jpg",
    });

    render(<ShareOptionsModal photos={[photo]} onClose={() => {}} />);

    expect(screen.getByText("Original")).toBeInTheDocument();
    expect(screen.getByText("Web-safe, original size")).toBeInTheDocument();
    expect(screen.getByText("Smaller size")).toBeInTheDocument();
  });

  it("keeps both options for a video-only selection regardless of metadata", () => {
    const video = createPhoto({
      path: "a/1.mp4",
      name: "1.mp4",
      mediaType: "video",
      originalUrl: "http://localhost/api/files/a/1.mp4",
    });

    render(<ShareOptionsModal photos={[video]} onClose={() => {}} />);

    expect(screen.getByText("Original")).toBeInTheDocument();
    expect(screen.getByText("Web-safe, original size")).toBeInTheDocument();
    expect(screen.getByText("Smaller size")).toBeInTheDocument();
  });

  it("renders into document.body by default so app-level stacking cannot cover it", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);

    try {
      render(<ShareOptionsModal photos={[createPhoto()]} onClose={() => {}} />, { container: host });

      expect(host.querySelector('[role="dialog"]')).toBeNull();
      expect(document.body.querySelector('[role="dialog"]')).toBeTruthy();
    } finally {
      host.remove();
    }
  });

  it("renders into a provided portal root when one is supplied", () => {
    const host = document.createElement("div");
    const portalRoot = document.createElement("div");
    document.body.append(host, portalRoot);

    try {
      render(
        <ShareOptionsModal photos={[createPhoto()]} onClose={() => {}} portalRoot={portalRoot} />,
        { container: host },
      );

      expect(host.querySelector('[role="dialog"]')).toBeNull();
      expect(portalRoot.querySelector('[role="dialog"]')).toBeTruthy();
    } finally {
      host.remove();
      portalRoot.remove();
    }
  });
});
