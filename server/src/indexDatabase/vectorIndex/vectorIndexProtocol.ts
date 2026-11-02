export type EmbeddingKind = "image" | "audio";
/** What a remove can name: one vector per file, or a video's frames (feedback #150). */
export type IndexedKind = EmbeddingKind | "videoFrames";
type FileKey = { folder: string; fileName: string };

/** Messages the main thread sends to vectorIndexWorker, each answered by `id`. */
export type VectorIndexRequest = { id: number } & (
  | { op: "load"; dbPath: string }
  | ({ op: "upsert"; kind: EmbeddingKind; vector: Uint8Array } & FileKey)
  | ({ op: "remove"; kinds: IndexedKind[] } & FileKey)
  | ({
      op: "upsertFrames";
      frames: Array<{ timeMs: number; embedding: Uint8Array }>;
    } & FileKey)
  | {
      op: "searchFrames";
      query: Uint8Array;
      limit: number;
      allowed?: Array<[folder: string, fileName: string]>;
    }
  | { op: "removeFolder"; folderPrefix: string }
  | { op: "move"; from: FileKey; to: FileKey }
  | {
      op: "search";
      kind: EmbeddingKind;
      query: Uint8Array;
      limit: number;
      allowed?: Array<[folder: string, fileName: string]>;
    }
);
