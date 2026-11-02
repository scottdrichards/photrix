import { parentPort } from "node:worker_threads";
import Database from "better-sqlite3";
import { VectorSet, type ScoredFile } from "./vectorSet.ts";
import { FrameVectorSet, type ScoredFrameFile } from "./frameVectorSet.ts";
import { decodeVideoFrameEmbeddings } from "../videoFrameEmbeddingCodec.ts";
import type { VectorIndexRequest } from "./vectorIndexProtocol.ts";

// Holds the in-memory embedding matrices off the main thread: a full scan is
// a few hundred ms of tight arithmetic that must not stall request handling.
// Requests are handled strictly in arrival order, which is what keeps the index
// consistent with the database: a write is posted only after it commits, and
// the initial load is the first request, so anything committed before the load
// is in the snapshot and anything after arrives as a later upsert/remove.

const sets = { image: new VectorSet(), audio: new VectorSet() };
const videoFrames = new FrameVectorSet();

type LoadCounts = { image: number; audio: number; videos: number };

const load = (dbPath: string): LoadCounts => {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        "SELECT folder, fileName, imageEmbedding, audioEmbedding, videoFrameEmbeddings FROM fileEmbeddings",
      )
      .iterate() as IterableIterator<{
      folder: string;
      fileName: string;
      imageEmbedding: Buffer | null;
      audioEmbedding: Buffer | null;
      videoFrameEmbeddings: Buffer | null;
    }>;
    for (const row of rows) {
      if (row.imageEmbedding) sets.image.upsert(row.folder, row.fileName, row.imageEmbedding);
      if (row.audioEmbedding) sets.audio.upsert(row.folder, row.fileName, row.audioEmbedding);
      if (row.videoFrameEmbeddings) {
        videoFrames.upsert(row.folder, row.fileName, decodeVideoFrameEmbeddings(row.videoFrameEmbeddings));
      }
    }
  } finally {
    db.close();
  }
  return { image: sets.image.size, audio: sets.audio.size, videos: videoFrames.size };
};

const handle = (
  request: VectorIndexRequest,
): ScoredFile[] | ScoredFrameFile[] | LoadCounts | null => {
  switch (request.op) {
    case "load":
      return load(request.dbPath);
    case "upsert":
      sets[request.kind].upsert(request.folder, request.fileName, request.vector);
      return null;
    case "remove":
      for (const kind of request.kinds) {
        if (kind === "videoFrames") videoFrames.remove(request.folder, request.fileName);
        else sets[kind].remove(request.folder, request.fileName);
      }
      return null;
    case "removeFolder":
      sets.image.removeFolder(request.folderPrefix);
      sets.audio.removeFolder(request.folderPrefix);
      videoFrames.removeFolder(request.folderPrefix);
      return null;
    case "move":
      sets.image.move(request.from, request.to);
      sets.audio.move(request.from, request.to);
      videoFrames.move(request.from, request.to);
      return null;
    case "upsertFrames":
      videoFrames.upsert(request.folder, request.fileName, request.frames);
      return null;
    case "search":
      return sets[request.kind].search(request.query, request.limit, request.allowed);
    case "searchFrames":
      return videoFrames.search(request.query, request.limit, request.allowed);
  }
};

parentPort!.on("message", (request: VectorIndexRequest) => {
  const response = (() => {
    try {
      return { id: request.id, result: handle(request) };
    } catch (error) {
      // Crossing the thread boundary loses the Error prototype; send the
      // message and stack so the caller can rethrow something readable.
      const { message, stack } = error instanceof Error ? error : new Error(String(error));
      return { id: request.id, error: { message, stack } };
    }
  })();
  parentPort!.postMessage(response);
});
