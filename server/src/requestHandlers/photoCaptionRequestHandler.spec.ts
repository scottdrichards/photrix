import { afterAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeRequest, recordResponse } from "./handlerTest.fixture.ts";

// The vision model, its cache and the resize are the expensive parts; the
// contract under test is everything around them.
const getCachedPhotoCaption = jest.fn(async (): Promise<string | null> => null);
const setCachedPhotoCaption = jest.fn(async () => undefined);
const generatePhotoCaption = jest.fn(async (): Promise<string | null> => "A dog on a beach");
const generatePhotoDescription = jest.fn(
  async (_image: string, _context: unknown, { onDelta }: { onDelta: (delta: string) => void }) => {
    onDelta("A dog ");
    onDelta("on a beach.");
    return "A dog on a beach.";
  },
);

const storageRoot = mkdtempSync(path.join(os.tmpdir(), "photrix-caption-"));
const resized = path.join(storageRoot, "resized.jpg");
writeFileSync(resized, Buffer.from("jpeg bytes"));

jest.unstable_mockModule("../photoCaption/photoCaptionCache.ts", () => ({
  getCachedPhotoCaption,
  setCachedPhotoCaption,
}));
jest.unstable_mockModule("../photoCaption/generatePhotoCaption.ts", () => ({
  generatePhotoCaption,
  generatePhotoDescription,
}));
jest.unstable_mockModule("../imageProcessing/convertImage.ts", () => ({
  convertImage: jest.fn(async () => resized),
}));

const { photoCaptionRequestHandler } = await import("./photoCaptionRequestHandler.ts");

type FileRecord = { mimeType?: string; aiDescription?: string; dateTaken?: number; folder?: string };

const setup = (record: FileRecord | null = { mimeType: "image/jpeg", folder: "/2024/" }) => {
  const database = {
    getFileRecord: jest.fn(async () => record),
    setAiDescription: jest.fn(async () => undefined),
    faces: {
      getPeopleFacesForFile: jest.fn(async () => [{ name: "Avery" }, { name: null }, { name: "Avery" }]),
    },
  };
  const call = async (url: string) => {
    const recorded = recordResponse();
    await photoCaptionRequestHandler(fakeRequest("GET", url), recorded.res, {
      database: database as never,
      storageRoot,
    });
    return recorded;
  };
  return { call, database };
};

/** The `data:` events of a server-sent event stream. */
const events = (stream: string) =>
  stream
    .split("\n\n")
    .filter((block) => block.startsWith("data: "))
    .map((block) => JSON.parse(block.slice("data: ".length)) as Record<string, unknown>);

beforeEach(() => {
  jest.clearAllMocks();
  getCachedPhotoCaption.mockResolvedValue(null);
  generatePhotoCaption.mockResolvedValue("A dog on a beach");
});

afterAll(() => {
  rmSync(storageRoot, { recursive: true, force: true });
});

describe("photoCaptionRequestHandler", () => {
  it("answers 400 without a path", async () => {
    const response = await setup().call("/api/photos/caption");
    expect(response.status()).toBe(400);
    expect(response.json()).toEqual({ error: "Missing path parameter" });
  });

  it.each([
    ["a parent-directory path", "../outside.jpg"],
    ["an encoded parent-directory path", encodeURIComponent("../../etc/passwd")],
    ["a path that climbs out after descending", "2024/../../outside.jpg"],
  ])("answers 403 for %s, before touching the model", async (_label, rawPath) => {
    const { call, database } = setup();
    const response = await call(`/api/photos/caption?path=${rawPath}`);
    expect(response.status()).toBe(403);
    expect(response.json()).toEqual({ error: "Access denied" });
    expect(database.getFileRecord).not.toHaveBeenCalled();
    expect(generatePhotoCaption).not.toHaveBeenCalled();
  });

  it("serves a cached caption without generating one", async () => {
    getCachedPhotoCaption.mockResolvedValue("Cached words");
    const response = await setup().call("/api/photos/caption?path=/2024/a.jpg");
    expect(response.json()).toEqual({ caption: "Cached words" });
    expect(generatePhotoCaption).not.toHaveBeenCalled();
  });

  it("gives a video no caption rather than an error", async () => {
    const response = await setup({ mimeType: "video/mp4" }).call("/api/photos/caption?path=/2024/a.mp4");
    expect(response.status()).toBe(200);
    expect(response.json()).toEqual({ caption: null });
    expect(generatePhotoCaption).not.toHaveBeenCalled();
  });

  it("generates, names the people in it once each, and caches the caption", async () => {
    const response = await setup().call("/api/photos/caption?path=/2024/a.jpg");
    expect(response.status()).toBe(200);
    expect(response.json()).toEqual({ caption: "A dog on a beach" });
    expect(generatePhotoCaption).toHaveBeenCalledWith(
      Buffer.from("jpeg bytes").toString("base64"),
      { peopleNames: ["Avery"], dateTaken: null, folder: "/2024/" },
      expect.anything(),
    );
    expect(setCachedPhotoCaption).toHaveBeenCalledWith(
      path.join(storageRoot, "/2024/a.jpg"),
      "A dog on a beach",
    );
  });

  it("answers 502 when the model gives nothing usable", async () => {
    generatePhotoCaption.mockResolvedValue(null);
    const response = await setup().call("/api/photos/caption?path=/2024/a.jpg");
    expect(response.status()).toBe(502);
    expect(setCachedPhotoCaption).not.toHaveBeenCalled();
  });

  it("answers 502 when generation fails", async () => {
    generatePhotoCaption.mockRejectedValue(new Error("model offline"));
    const response = await setup().call("/api/photos/caption?path=/2024/a.jpg");
    expect(response.status()).toBe(502);
    expect(response.json()).toEqual({ error: "Caption generation failed; retry the photo" });
  });
});

describe("photoCaptionRequestHandler, kind=description", () => {
  const url = "/api/photos/caption?path=/2024/a.jpg&kind=description";

  it("streams a stored description without calling the model", async () => {
    const response = await setup({ mimeType: "image/jpeg", aiDescription: "Stored." }).call(url);
    expect(response.status()).toBe(200);
    expect(response.header("Content-Type")).toBe("text/event-stream");
    expect(events(response.text())).toEqual([{ description: "Stored." }]);
    expect(generatePhotoDescription).not.toHaveBeenCalled();
  });

  it("streams the deltas, then stores and sends the whole description", async () => {
    const { call, database } = setup();
    const response = await call(url);
    expect(events(response.text())).toEqual([
      { delta: "A dog " },
      { delta: "on a beach." },
      { description: "A dog on a beach." },
    ]);
    expect(database.setAiDescription).toHaveBeenCalledWith("/2024/a.jpg", "A dog on a beach.");
  });

  it("sends a null description for a video", async () => {
    const response = await setup({ mimeType: "video/mp4" }).call(url);
    expect(events(response.text())).toEqual([{ description: null }]);
  });

  it("reports a failure as an error event, not a broken stream", async () => {
    generatePhotoDescription.mockRejectedValueOnce(new Error("model offline"));
    const response = await setup().call(url);
    expect(response.status()).toBe(200);
    expect(events(response.text())).toEqual([{ error: "Description generation failed" }]);
    expect(response.res.writableEnded).toBe(true);
  });
});
