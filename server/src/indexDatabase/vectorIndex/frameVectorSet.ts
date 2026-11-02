import { VectorSet } from "./vectorSet.ts";

export type ScoredFrameFile = {
  folder: string;
  fileName: string;
  similarity: number;
  /** The best-matching frame, in ms into the video. */
  timeMs: number;
};

type FileKey = { folder: string; fileName: string };

/**
 * The CLIP vectors of video frames, several per video (feedback #150). A
 * search ranks frames and returns each video once, at its best frame, so a
 * video scores as well as the one moment that matches rather than an average
 * over everything else in it.
 *
 * Built on VectorSet by giving each frame its own row, named after its video
 * and time. `byFile` remembers which rows belong to which video, so a video is
 * replaced, removed, moved or allowed as a whole.
 */
export class FrameVectorSet {
  private readonly rows = new VectorSet();
  private readonly byFile = new Map<string, number[]>();

  private static fileKey(folder: string, fileName: string): string {
    return `${folder}\u0000${fileName}`;
  }

  /** The row name for one frame: the video's file name plus the frame time. */
  private static frameName(fileName: string, timeMs: number): string {
    return `${fileName}\u0001${timeMs}`;
  }

  private static parseFrameName(rowFileName: string): { fileName: string; timeMs: number } {
    const at = rowFileName.lastIndexOf("\u0001");
    return { fileName: rowFileName.slice(0, at), timeMs: Number(rowFileName.slice(at + 1)) };
  }

  /** Number of videos held. */
  get size(): number {
    return this.byFile.size;
  }

  /** Replaces every frame of a video. */
  upsert(
    folder: string,
    fileName: string,
    frames: ReadonlyArray<{ timeMs: number; embedding: Uint8Array }>,
  ): void {
    this.remove(folder, fileName);
    if (frames.length === 0) return;
    const times: number[] = [];
    for (const { timeMs, embedding } of frames) {
      if (times.includes(timeMs)) continue;
      this.rows.upsert(folder, FrameVectorSet.frameName(fileName, timeMs), embedding);
      times.push(timeMs);
    }
    this.byFile.set(FrameVectorSet.fileKey(folder, fileName), times);
  }

  remove(folder: string, fileName: string): void {
    const key = FrameVectorSet.fileKey(folder, fileName);
    for (const timeMs of this.byFile.get(key) ?? []) {
      this.rows.remove(folder, FrameVectorSet.frameName(fileName, timeMs));
    }
    this.byFile.delete(key);
  }

  removeFolder(folderPrefix: string): void {
    for (const key of [...this.byFile.keys()]) {
      const at = key.indexOf("\u0000");
      const folder = key.slice(0, at);
      if (folder.startsWith(folderPrefix)) this.remove(folder, key.slice(at + 1));
    }
  }

  move(from: FileKey, to: FileKey): void {
    const times = this.byFile.get(FrameVectorSet.fileKey(from.folder, from.fileName));
    if (!times) return;
    this.remove(to.folder, to.fileName);
    for (const timeMs of times) {
      this.rows.move(
        { folder: from.folder, fileName: FrameVectorSet.frameName(from.fileName, timeMs) },
        { folder: to.folder, fileName: FrameVectorSet.frameName(to.fileName, timeMs) },
      );
    }
    this.byFile.delete(FrameVectorSet.fileKey(from.folder, from.fileName));
    this.byFile.set(FrameVectorSet.fileKey(to.folder, to.fileName), times);
  }

  /**
   * The `limit` best videos, best first, each at its best frame. With
   * `allowedFiles`, only those videos are ranked.
   */
  search(
    encodedQuery: Uint8Array,
    limit: number,
    allowedFiles?: ReadonlyArray<readonly [folder: string, fileName: string]>,
  ): ScoredFrameFile[] {
    if (this.byFile.size === 0 || limit <= 0) return [];
    const allowedFrames = allowedFiles?.flatMap(([folder, fileName]) =>
      (this.byFile.get(FrameVectorSet.fileKey(folder, fileName)) ?? []).map(
        (timeMs) => [folder, FrameVectorSet.frameName(fileName, timeMs)] as const,
      ),
    );
    const best = new Map<string, ScoredFrameFile>();
    // Frames come back best first, so a video's first frame is its best. Ask
    // for more frames until `limit` videos are found or the frames run out.
    for (let wanted = limit * 8; ; wanted *= 4) {
      const frames = this.rows.search(encodedQuery, wanted, allowedFrames);
      for (const frame of frames) {
        const { fileName, timeMs } = FrameVectorSet.parseFrameName(frame.fileName);
        const key = FrameVectorSet.fileKey(frame.folder, fileName);
        if (best.has(key)) continue;
        best.set(key, { folder: frame.folder, fileName, similarity: frame.similarity, timeMs });
        if (best.size >= limit) return [...best.values()];
      }
      if (frames.length < wanted) return [...best.values()];
    }
  }
}
