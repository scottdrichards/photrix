import { describe, expect, it } from "@jest/globals";
import type {
  Task,
  TaskOrchestrator,
  TaskRunner,
} from "../taskOrchestrator/taskOrchestrator.ts";
import { registerBackgroundTasks } from "./registerBackgroundTasks.ts";

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const createRunner = (promise: Promise<void>): TaskRunner => ({
  onComplete: () => promise,
});

describe("registerBackgroundTasks", () => {
  it("queues dependent background stages only after upstream completion", async () => {
    const queued: Array<{ queue: string; task: Task }> = [];
    const taskOrchestrator = {
      addTask: (task: Task, queue: string) => {
        queued.push({ task, queue });
      },
    } as TaskOrchestrator;

    const scan = createDeferred();
    const exif = createDeferred();
    const analysis = createDeferred();

    registerBackgroundTasks(taskOrchestrator, {
      fileSystemScan: {
        name: "File system scan",
        priority: "high",
        start: () => createRunner(scan.promise),
      },
      fileMetadata: {
        name: "File metadata processing",
        start: () => createRunner(Promise.resolve()),
      },
      exifMetadata: {
        name: "EXIF metadata processing",
        start: () => createRunner(exif.promise),
      },
      imageAnalysis: {
        name: "Image analysis (faces + CLIP)",
        start: () => createRunner(analysis.promise),
      },
      faceAttributes: {
        name: "Face attributes (photo ready)",
        start: () => createRunner(Promise.resolve()),
      },
      faceClustering: {
        name: "Face clustering",
        start: () => createRunner(Promise.resolve()),
      },
      audioTranscription: {
        name: "Audio transcription (Whisper)",
        start: () => createRunner(Promise.resolve()),
      },
      audioEmbedding: {
        name: "Audio embedding (CLAP)",
        start: () => createRunner(Promise.resolve()),
      },
    });

    expect(queued.map(({ task }) => task.name)).toEqual(["File system scan"]);

    const scanRunner = queued[0]!.task.start();
    scan.resolve();
    await scanRunner.onComplete();

    expect(queued.map(({ task }) => task.name)).toEqual([
      "File system scan",
      "File metadata processing",
      "EXIF metadata processing",
      "Image analysis (faces + CLIP)",
    ]);

    const exifRunner = queued[2]!.task.start();
    exif.resolve();
    await exifRunner.onComplete();

    expect(queued.map(({ task }) => task.name)).toEqual([
      "File system scan",
      "File metadata processing",
      "EXIF metadata processing",
      "Image analysis (faces + CLIP)",
      "Audio transcription (Whisper)",
      "Audio embedding (CLAP)",
    ]);

    const analysisRunner = queued[3]!.task.start();
    analysis.resolve();
    await analysisRunner.onComplete();

    expect(queued.map(({ task }) => task.name)).toEqual([
      "File system scan",
      "File metadata processing",
      "EXIF metadata processing",
      "Image analysis (faces + CLIP)",
      "Audio transcription (Whisper)",
      "Audio embedding (CLAP)",
      "Face clustering",
      "Face attributes (photo ready)",
    ]);
  });

  it("re-queues drained pipeline stages when files change later", async () => {
    const queued: Array<{ queue: string; task: Task }> = [];
    const taskOrchestrator = {
      addTask: (task: Task, queue: string) => {
        queued.push({ task, queue });
      },
    } as TaskOrchestrator;

    // Every stage completes immediately so the initial pass fully drains.
    const immediate = (name: string): Task => ({
      name,
      start: () => createRunner(Promise.resolve()),
    });

    const { notifyFilesChanged } = registerBackgroundTasks(taskOrchestrator, {
      fileSystemScan: immediate("File system scan"),
      fileMetadata: immediate("File metadata processing"),
      exifMetadata: immediate("EXIF metadata processing"),
      imageAnalysis: immediate("Image analysis (faces + CLIP)"),
      faceAttributes: immediate("Face attributes (photo ready)"),
      faceClustering: immediate("Face clustering"),
      audioTranscription: immediate("Audio transcription (Whisper)"),
      audioEmbedding: immediate("Audio embedding (CLAP)"),
    });

    // Drive the initial run to completion by starting and awaiting each queued
    // task, which cascades the dependent stages.
    for (let i = 0; i < queued.length; i++) {
      await queued[i]!.task.start().onComplete();
    }

    const afterInitial = queued.length;
    expect(afterInitial).toBeGreaterThan(0);

    // A change arrives after everything drained: the entry stages re-queue.
    notifyFilesChanged();

    const requeued = queued.slice(afterInitial).map(({ task }) => task.name);
    expect(requeued).toEqual([
      "File metadata processing",
      "EXIF metadata processing",
      "Image analysis (faces + CLIP)",
    ]);
  });

  it("does not re-queue a stage that is still running", async () => {
    const queued: Array<{ queue: string; task: Task }> = [];
    const taskOrchestrator = {
      addTask: (task: Task, queue: string) => {
        queued.push({ task, queue });
      },
    } as TaskOrchestrator;

    const fileMetadata = createDeferred();
    const immediate = (name: string): Task => ({
      name,
      start: () => createRunner(Promise.resolve()),
    });

    const { notifyFilesChanged } = registerBackgroundTasks(taskOrchestrator, {
      fileSystemScan: immediate("File system scan"),
      fileMetadata: {
        name: "File metadata processing",
        start: () => createRunner(fileMetadata.promise),
      },
      exifMetadata: immediate("EXIF metadata processing"),
      imageAnalysis: immediate("Image analysis (faces + CLIP)"),
      faceAttributes: immediate("Face attributes (photo ready)"),
      faceClustering: immediate("Face clustering"),
      audioTranscription: immediate("Audio transcription (Whisper)"),
      audioEmbedding: immediate("Audio embedding (CLAP)"),
    });

    // Complete the scan so the pipeline queues; start file-metadata but leave it
    // running (unresolved).
    await queued[0]!.task.start().onComplete();
    const fileMetaTask = queued.find(
      ({ task }) => task.name === "File metadata processing",
    )!.task;
    void fileMetaTask.start().onComplete();

    const before = queued.filter(
      ({ task }) => task.name === "File metadata processing",
    ).length;

    // A change while it is mid-run must not spawn a second concurrent instance.
    notifyFilesChanged();

    const after = queued.filter(
      ({ task }) => task.name === "File metadata processing",
    ).length;
    expect(after).toBe(before);
  });
});
