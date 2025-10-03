import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PhotrixHttpServer } from "./httpServer.js";

const SAMPLE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABDQottAAAAABJRU5ErkJggg==";

describe("PhotrixHttpServer", () => {
  let server: PhotrixHttpServer;
  let tempDir: string;
  let baseUrl: string;
  let sampleBuffer: Buffer;

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "photrix-http-"));
    sampleBuffer = Buffer.from(SAMPLE_IMAGE_BASE64, "base64");
    await writeFile(path.join(tempDir, "sample.png"), sampleBuffer);

    server = new PhotrixHttpServer({
      mediaRoot: tempDir,
      indexer: {
        watch: false,
        awaitWriteFinish: false,
      },
      cors: {
        origin: "http://localhost:5173",
        allowCredentials: false,
      },
    });

    const { port, host } = await server.start(0, "127.0.0.1");
    baseUrl = `http://${host}:${port}`;
  });

  afterAll(async () => {
    await server.stop();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lists indexed files with selected metadata", async () => {
    const response = await fetch(
      `${baseUrl}/api/files?metadata=name,mimeType&pageSize=10`,
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.total).toBe(1);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].path).toBe("sample.png");
    expect(payload.items[0].metadata?.name).toBeUndefined();
    expect(payload.items[0].metadata?.mimeType).toContain("image/png");
    expect(Object.keys(payload.items[0].metadata ?? {})).toEqual(["mimeType"]);
  });

  it("uses the first metadata entry when provided multiple times", async () => {
    const response = await fetch(
      `${baseUrl}/api/files?metadata=mimeType&metadata=name,dimensions&pageSize=5`,
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    const metadata = payload.items[0].metadata ?? {};
    expect(metadata.mimeType).toContain("image/png");
  expect(metadata.name).toBeUndefined();
  expect(metadata.dimensions).toEqual({ width: 1, height: 1 });
  expect(Object.keys(metadata)).toEqual(["mimeType", "dimensions"]);
  });

  it("serves the original file bytes", async () => {
    const response = await fetch(
      `${baseUrl}/api/file?path=sample.png&representation=original`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.equals(sampleBuffer)).toBe(true);
  });

  it("serves file metadata as JSON", async () => {
    const response = await fetch(
      `${baseUrl}/api/file?path=sample.png&representation=metadata&metadata=mimeType,size`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const metadata = await response.json();
    expect(metadata.name).toBeUndefined();
    expect(metadata.mimeType).toContain("image/png");
    expect(typeof metadata.size).toBe("number");
    expect(metadata.size).toBeGreaterThan(0);
    expect(Object.keys(metadata)).toEqual(["mimeType", "size"]);
  });

  it("returns an empty metadata object when unsupported keys are requested", async () => {
    const response = await fetch(
      `${baseUrl}/api/file?path=sample.png&representation=metadata&metadata=name`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const metadata = await response.json();
    expect(metadata).toEqual({});
  });

  it("exposes static uploads path", async () => {
    const response = await fetch(`${baseUrl}/uploads/sample.png`);
    expect(response.status).toBe(200);
    const buffer = Buffer.from(await response.arrayBuffer());
    expect(buffer.equals(sampleBuffer)).toBe(true);
  });

  it("returns 404 for unknown paths", async () => {
    const response = await fetch(`${baseUrl}/api/file?path=missing.jpg`);
    expect(response.status).toBe(404);
  });
});
