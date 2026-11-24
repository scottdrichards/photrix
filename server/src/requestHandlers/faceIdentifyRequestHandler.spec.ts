import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { overrideConfig } from "../config/config.fixture.ts";
import type { DetectedFace } from "../faceDetection/faceDetector.type.ts";
import { invalidateNamedCentroidCache } from "../people/identify/centroidCache.ts";
import type { AnalyzeImage } from "../people/identify/identifyFrames.ts";
import { markWorkerEvictedError } from "../taskOrchestrator/computeWorkers.ts";
import { faceIdentifyRequestHandler } from "./faceIdentifyRequestHandler.ts";
import { fakeRequest, recordResponse } from "./handlerTest.fixture.ts";
import { peopleRequestHandler } from "./peopleRequestHandler.ts";

const cacheDir = mkdtempSync(path.join(os.tmpdir(), "photrix-face-identify-"));
overrideConfig({ CACHE_DIR: cacheDir });

const DIMENSIONS = 4;

/** A Float32 centroid BLOB along one axis, as faceClusters stores it. */
const centroid = (axis: number): Buffer => {
  const vector = new Float32Array(DIMENSIONS);
  vector[axis] = 1;
  return Buffer.from(vector.buffer.slice(0));
};

/** A confident, large face pointing at one person's centroid. */
const faceOf = (axis: number): DetectedFace => {
  const embedding = new Float64Array(DIMENSIONS);
  embedding[axis] = 1;
  return { box: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 }, confidence: 0.99, embedding };
};

let jpeg: Buffer;
let frameServer: http.Server;
let frameHost: string;
const frameHits: string[] = [];

beforeAll(async () => {
  jpeg = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 90, g: 120, b: 150 } },
  })
    .jpeg()
    .toBuffer();
  // Stands in for a camera on the LAN: frames, and a Frigate-style event record.
  frameServer = http.createServer((req, res) => {
    frameHits.push(req.url ?? "");
    if (req.url === "/api/events/evt-1") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ camera: "cam-a", start_time: 1000, end_time: 1010, data: { box: [0.2, 0.2, 0.4, 0.6] } }));
      return;
    }
    if (req.url === "/api/events/no-box") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ camera: "cam-a", start_time: 1000 }));
      return;
    }
    if (req.url?.endsWith(".jpg")) {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(jpeg);
      return;
    }
    if (req.url === "/leave") {
      res.writeHead(302, { Location: "http://203.0.113.7/frame.jpg" });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => frameServer.listen(0, "127.0.0.1", resolve));
  frameHost = `127.0.0.1:${(frameServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => frameServer.close(resolve));
  rmSync(cacheDir, { recursive: true, force: true });
});

const namedCentroids = [
  { clusterId: 1, name: "Avery", centroid: centroid(0) },
  { clusterId: 2, name: "Blake", centroid: centroid(1) },
  { clusterId: 3, name: "Blake", centroid: centroid(2) },
];

const setup = (analyze: AnalyzeImage = async () => ({ faces: [] })) => {
  const getNamedFaceCentroids = jest.fn(async () => namedCentroids);
  const analyzeImage = jest.fn(analyze);
  const database = { faceClusters: { getNamedFaceCentroids } } as never;
  const call = async (method: string, url: string, body?: unknown, headers?: http.IncomingHttpHeaders) => {
    const recorded = recordResponse();
    await faceIdentifyRequestHandler(fakeRequest(method, url, body, headers), recorded.res, {
      database,
      analyzeImage,
    });
    return recorded;
  };
  return { call, analyzeImage, getNamedFaceCentroids };
};

const identify = "/api/faces/identify";
const json = { "content-type": "application/json" };

beforeEach(() => {
  invalidateNamedCentroidCache();
  frameHits.length = 0;
});

describe("faceIdentifyRequestHandler routing", () => {
  it("lists the people who can be recognized, each once", async () => {
    const { call } = setup();
    const response = await call("GET", "/api/faces/people");
    expect(response.status()).toBe(200);
    expect(response.json()).toEqual({ people: ["Avery", "Blake"], centroids: 3 });
  });

  it.each([
    ["GET", identify],
    ["POST", "/api/faces/people"],
    ["POST", "/api/faces/other"],
  ])("answers %s %s with 404", async (method, url) => {
    const { call, analyzeImage } = setup();
    const response = await call(method, url, "");
    expect(response.status()).toBe(404);
    expect(analyzeImage).not.toHaveBeenCalled();
  });
});

describe("faceIdentifyRequestHandler validation", () => {
  it.each([
    ["an empty body", "", json, "Empty request body"],
    ["a body that is neither an image nor JSON", "not json", json, "Body must be image bytes"],
    ["JSON without a frame", { other: 1 }, json, "JSON body must contain"],
    ["an empty imageUrls", { imageUrls: [] }, json, "imageUrls was empty"],
    ["too many frames", { imageUrls: Array(7).fill("http://127.0.0.1/a.jpg") }, json, "at most 6 frames"],
    ["a non-URL entry", { imageUrls: [42, 43] }, json, "must be a URL string or an object"],
    ["an entry without a url", { imageUrls: [{ box: [0, 0, 1, 1] }] }, json, "needs a url"],
    ["a malformed box", { imageUrls: [{ url: "http://127.0.0.1/a.jpg", box: [0, 0, 1] }] }, json, "box must be four numbers"],
    ["empty base64", { imageBase64: "" }, json, "imageBase64 decoded to nothing"],
    ["a Frigate event without an id", { frigateEvent: { host: "127.0.0.1:5000" } }, json, "needs both host and id"],
  ])("answers %s with 400", async (_label, body, headers, message) => {
    const { call, analyzeImage } = setup();
    const response = await call("POST", identify, body, headers);
    expect(response.status()).toBe(400);
    expect(response.json().error).toContain(message);
    expect(analyzeImage).not.toHaveBeenCalled();
  });

  it("refuses a body over the size cap with 400", async () => {
    const { call } = setup();
    const response = await call("POST", identify, Buffer.alloc(16 * 1024 * 1024 + 1), {
      "content-type": "image/jpeg",
    });
    expect(response.status()).toBe(400);
    expect(response.json().error).toContain("Body exceeds");
  });
});

describe("faceIdentifyRequestHandler frame fetching", () => {
  it.each([
    ["a public address", { imageUrl: "http://203.0.113.7/frame.jpg" }],
    ["a DNS name", { imageUrl: "http://example.com/frame.jpg" }],
    ["a non-http scheme", { imageUrl: "file:///etc/passwd" }],
    ["a Frigate host on the internet", { frigateEvent: { host: "example.com:5000", id: "evt-1" } }],
  ])("refuses a frame URL on %s with 400, without fetching", async (_label, body) => {
    const { call, analyzeImage } = setup();
    const response = await call("POST", identify, body, json);
    expect(response.status()).toBe(400);
    expect(response.json().error).toMatch(/private\/LAN|http or https/);
    expect(analyzeImage).not.toHaveBeenCalled();
  });

  it("refuses a Frigate host that only looks private before its first colon", async () => {
    const { call } = setup();
    const response = await call(
      "POST",
      identify,
      { frigateEvent: { host: `${frameHost}@example.com`, id: "evt-1" } },
      json,
    );
    expect(response.status()).toBe(400);
    expect(response.json().error).toBe("frigateEvent host must be a private/LAN address");
    expect(frameHits).toEqual([]);
  });

  it("refuses a frame whose URL redirects off the LAN", async () => {
    const { call, analyzeImage } = setup();
    const response = await call("POST", identify, { imageUrl: `http://${frameHost}/leave` }, json);
    expect(response.status()).toBe(400);
    expect(response.json().error).toBe("Redirected away from a private/LAN address");
    expect(analyzeImage).not.toHaveBeenCalled();
  });

  it("fetches a private frame URL and crops it to the box", async () => {
    const { call, analyzeImage } = setup(async () => ({ faces: [faceOf(0)] }));
    const response = await call(
      "POST",
      identify,
      { imageUrl: `http://${frameHost}/a.jpg`, box: [0.25, 0.25, 0.5, 0.5], pad: 0 },
      json,
    );
    expect(response.status()).toBe(200);
    expect(analyzeImage).toHaveBeenCalledTimes(1);
    expect(response.json().frames).toEqual([
      { frame: 0, faces: 1, crop: { left: 160, top: 120, width: 320, height: 240 } },
    ]);
  });

  it("reads a Frigate event's frames from its record", async () => {
    const { call, analyzeImage } = setup();
    const response = await call(
      "POST",
      identify,
      { frigateEvent: { host: frameHost, id: "evt-1", frames: 2 } },
      json,
    );
    expect(response.status()).toBe(200);
    expect(frameHits[0]).toBe("/api/events/evt-1");
    expect(frameHits.slice(1).every((hit) => hit.startsWith("/api/cam-a/recordings/"))).toBe(true);
    expect(analyzeImage).toHaveBeenCalledTimes(2);
    expect(response.json()).toMatchObject({ framesSubmitted: 2, framesAnalyzed: 2 });
  });

  it("answers 400 for a Frigate event with nothing to crop to", async () => {
    const { call } = setup();
    const response = await call("POST", identify, { frigateEvent: { host: frameHost, id: "no-box" } }, json);
    expect(response.status()).toBe(400);
    expect(response.json().error).toContain("carries no box");
  });
});

describe("faceIdentifyRequestHandler answers", () => {
  it("treats a frame with nobody in it as an ordinary 200", async () => {
    const { call } = setup();
    const response = await call("POST", identify, jpeg, { "content-type": "image/jpeg" });
    expect(response.status()).toBe(200);
    expect(response.json()).toMatchObject({ faceCount: 0, people: [], topPerson: null, framesAnalyzed: 1 });
  });

  it("names a known face from base64 and reports how it scored", async () => {
    const { call } = setup(async () => ({ faces: [faceOf(1)] }));
    const response = await call(
      "POST",
      identify,
      { imageBase64: `data:image/jpeg;base64,${jpeg.toString("base64")}` },
      json,
    );
    expect(response.status()).toBe(200);
    const body = response.json<{ people: string[]; topPerson: string; matches: Array<{ frame: number }>; knownPeople: number; elapsedMs: number }>();
    expect(body.people).toEqual(["Blake"]);
    expect(body.topPerson).toBe("Blake");
    expect(body.matches[0].frame).toBe(0);
    expect(body.knownPeople).toBe(2);
    expect(typeof body.elapsedMs).toBe("number");
  });

  it("stops at the first frame that names someone", async () => {
    const { call, analyzeImage } = setup(async () => ({ faces: [faceOf(0)] }));
    const urls = [1, 2, 3].map((n) => `http://${frameHost}/${n}.jpg`);
    const response = await call("POST", identify, { imageUrls: urls }, json);
    expect(response.status()).toBe(200);
    expect(analyzeImage).toHaveBeenCalledTimes(1);
    expect(response.json()).toMatchObject({ framesSubmitted: 3, framesAnalyzed: 1, people: ["Avery"] });
  });

  it("notes an unreadable frame among several and keeps going", async () => {
    const { call } = setup(async () => ({ faces: [faceOf(0)] }));
    const response = await call(
      "POST",
      identify,
      { imageUrls: [`http://${frameHost}/missing`, `http://${frameHost}/2.jpg`] },
      json,
    );
    expect(response.status()).toBe(200);
    expect(response.json().frames).toEqual([
      { frame: 0, faces: 0, error: "Frame fetch returned HTTP 404" },
      { frame: 1, faces: 1 },
    ]);
  });

  it("answers 502 when no frame could be analyzed", async () => {
    const { call } = setup(async () => ({ facesError: "detector failed" }));
    const response = await call("POST", identify, jpeg, { "content-type": "image/jpeg" });
    expect(response.status()).toBe(502);
    expect(response.json()).toEqual({
      error: "No frame could be analyzed",
      frames: [{ frame: 0, faces: 0, error: "detector failed" }],
    });
  });

  it("retries a frame once when its worker was evicted for a user", async () => {
    let calls = 0;
    const { call } = setup(async () => {
      calls += 1;
      if (calls === 1) throw markWorkerEvictedError(new Error("evicted"));
      return { faces: [] };
    });
    const response = await call("POST", identify, jpeg, { "content-type": "image/jpeg" });
    expect(response.status()).toBe(200);
    expect(calls).toBe(2);
  });

  it("applies the threshold query parameters", async () => {
    const { call } = setup(async () => ({ faces: [faceOf(0)] }));
    const response = await call("POST", `${identify}?threshold=1.5&strongThreshold=2`, jpeg, {
      "content-type": "image/jpeg",
    });
    expect(response.status()).toBe(200);
    expect(response.json()).toMatchObject({ faceCount: 1, people: [] });
  });
});

describe("faceIdentifyRequestHandler load shedding", () => {
  it("sheds a fourth concurrent request with 429 and Retry-After", async () => {
    const releases: Array<() => void> = [];
    let hold = true;
    const { call } = setup(async () => {
      if (hold) await new Promise<void>((resolve) => releases.push(resolve));
      return { faces: [] };
    });
    const send = () => call("POST", identify, jpeg, { "content-type": "image/jpeg" });
    const inFlight = [send(), send(), send()];
    while (releases.length < 3) await new Promise((resolve) => setTimeout(resolve, 10));

    const shed = await send();
    expect(shed.status()).toBe(429);
    expect(shed.header("Retry-After")).toBe("2");
    expect(shed.json()).toEqual({ error: "Face identification is busy", faceCount: 0, people: [] });

    hold = false;
    releases.forEach((release) => release());
    expect((await Promise.all(inFlight)).map((r) => r.status())).toEqual([200, 200, 200]);
    // The slots are released again.
    expect((await send()).status()).toBe(200);
  });
});

describe("named-centroid cache", () => {
  it("is reused between requests and dropped by any people edit", async () => {
    const { call, getNamedFaceCentroids } = setup();
    await call("GET", "/api/faces/people");
    await call("GET", "/api/faces/people");
    expect(getNamedFaceCentroids).toHaveBeenCalledTimes(1);

    const people = recordResponse();
    const faceClusters = { renameCluster: jest.fn(async () => true) };
    await peopleRequestHandler(
      fakeRequest("POST", "/api/people/rename", { clusterId: "1", name: "Avery" }),
      people.res,
      { faceClusters } as never,
    );
    await call("GET", "/api/faces/people");
    expect(getNamedFaceCentroids).toHaveBeenCalledTimes(2);
  });
});
