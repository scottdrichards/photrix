import { describe, expect, it } from "@jest/globals";
import { pathToken, redactRequestPath, scrubDiagnostics } from "./privacy.ts";
import { listDiagnosticsEvents, recordClientDiagnosticEvent } from "./diagnosticsStore.ts";

describe("redactRequestPath", () => {
  it("drops the query string, where search text travels", () => {
    expect(redactRequestPath("/api/search?q=beach%20sunset&page=2")).toBe("/api/search");
    expect(redactRequestPath("/api/suggestions?q=gran")).toBe("/api/suggestions");
  });

  it("collapses routes whose path names a library file or folder", () => {
    expect(redactRequestPath("/api/files/2021/Trip/IMG_0001.jpg?representation=preview")).toBe(
      "/api/files/:path",
    );
    expect(redactRequestPath("/api/folders/2021/Trip")).toBe("/api/folders/:path");
  });

  it("leaves routes without private segments alone", () => {
    expect(redactRequestPath("/api/health")).toBe("/api/health");
    expect(redactRequestPath("/api/folders/")).toBe("/api/folders/");
    expect(redactRequestPath("/api/faces/identify")).toBe("/api/faces/identify");
  });
});

describe("pathToken", () => {
  it("is stable within a process but does not contain the path", () => {
    const token = pathToken("2021/Trip/IMG_0001.jpg");
    expect(token).toBe(pathToken("2021/Trip/IMG_0001.jpg"));
    expect(token).not.toBe(pathToken("2021/Trip/IMG_0002.jpg"));
    expect(token).toMatch(/^p:[0-9a-f]{12}$/);
  });
});

describe("scrubDiagnostics", () => {
  it("tokenizes paths, drops search text, and scrubs the message", () => {
    const path = "2021/Trip/clip.mov";
    const { message, data } = scrubDiagnostics(`Negotiating playback for ${path}`, {
      path,
      q: "beach sunset",
      levels: 3,
      result: { mode: "hls", url: `/api/files/${encodeURIComponent(path)}?representation=hls` },
    });

    const serialized = JSON.stringify({ message, data });
    expect(serialized).not.toContain("Trip");
    expect(serialized).not.toContain("beach");
    expect(message).toBe(`Negotiating playback for ${pathToken(path)}`);
    expect(data).toEqual({
      path: pathToken(path),
      levels: 3,
      result: { mode: "hls", url: "/api/files/:path" },
    });
  });
});

describe("diagnostics store", () => {
  it("never keeps a client event's raw URL or path", () => {
    recordClientDiagnosticEvent({
      level: "info",
      event: "privacy.test",
      message: "Selected video 2021/Trip/clip.mov",
      url: "/api/search?q=beach%20sunset",
      data: { path: "2021/Trip/clip.mov" },
    });

    const [event] = listDiagnosticsEvents().filter((e) => e.event === "privacy.test");
    const serialized = JSON.stringify(event);
    expect(event.url).toBe("/api/search");
    expect(serialized).not.toContain("Trip");
    expect(serialized).not.toContain("beach");
  });
});
