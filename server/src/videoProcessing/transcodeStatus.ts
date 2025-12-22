export type TranscodeKind = "preview" | "webSafe" | "thumbnail";

export type TranscodeStatus = {
  id: string;
  kind: TranscodeKind;
  filePath: string;
  height: string | number;
  startedAt: string;
  updatedAt: string;
  state: "running" | "done" | "error";
  durationSeconds?: number;
  outTimeSeconds?: number;
  percent?: number;
  speed?: string;
  fps?: number;
  message?: string;
};

const active = new Map<string, TranscodeStatus>();

export const upsertTranscodeStatus = (status: TranscodeStatus) => {
  active.set(status.id, status);
};

export const removeTranscodeStatus = (id: string) => {
  active.delete(id);
};

export const getTranscodeStatusSnapshot = (): TranscodeStatus[] => {
  return Array.from(active.values()).sort((a, b) =>
    a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0,
  );
};
