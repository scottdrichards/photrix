export type EmbeddingKind = "image" | "audio";
type FileKey = { folder: string; fileName: string };

/** Messages the main thread sends to vectorIndexWorker, each answered by `id`. */
export type VectorIndexRequest = { id: number } & (
  | { op: "load"; dbPath: string }
  | ({ op: "upsert"; kind: EmbeddingKind; vector: Uint8Array } & FileKey)
  | ({ op: "remove"; kinds: EmbeddingKind[] } & FileKey)
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
