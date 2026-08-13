import type {
  Task,
  TaskOrchestrator,
  TaskRunner,
} from "../taskOrchestrator/taskOrchestrator.ts";

type BackgroundTaskPlan = {
  fileSystemScan: Task;
  fileMetadata: Task;
  exifMetadata: Task;
  imageAnalysis: Task;
  faceAttributes: Task;
  faceClustering: Task;
  momentClustering: Task;
  audioTranscription: Task;
  audioEmbedding: Task;
};

export type BackgroundTaskHandle = {
  /**
   * Re-run the processing pipeline to pick up files that were added or changed
   * after the initial backlog was cleared (e.g. by the live filesystem watcher).
   */
  notifyFilesChanged: () => void;
};

export const registerBackgroundTasks = (
  taskOrchestrator: TaskOrchestrator,
  tasks: BackgroundTaskPlan,
): BackgroundTaskHandle => {
  // A re-entrant wrapper around a background task. `ensure()` queues the task,
  // but is a no-op while it is already queued or running so the same processor
  // never runs twice concurrently. Crucially the "active" flag clears when the
  // run drains, so a later `ensure()` re-queues a fresh run — this is how
  // filesystem changes get processed after the initial backlog is exhausted.
  // `onDrain` fires after each successful run, cascading to dependent stages.
  const reentrant = (base: Task, onDrain?: () => void) => {
    let active = false;
    const task: Task = {
      ...base,
      start: () => {
        const runner = base.start();
        let completion: Promise<void> | null = null;
        return {
          ...runner,
          onComplete: () =>
            (completion ??= runner
              .onComplete()
              .finally(() => {
                active = false;
              })
              .then(() => onDrain?.())),
        } satisfies TaskRunner;
      },
    };
    return {
      ensure: () => {
        if (active) return;
        active = true;
        taskOrchestrator.addTask(task, "background");
      },
    };
  };

  const faceClustering = reentrant(tasks.faceClustering);
  const audioTranscription = reentrant(tasks.audioTranscription);
  const audioEmbedding = reentrant(tasks.audioEmbedding);
  // Attribute backfill only ever has work for faces detected *before* the
  // attributes existed — new detections carry them already. Cascading it off
  // image analysis means it starts once the detection backlog drains (rather
  // than competing with it for the shared Python worker) and re-checks whenever
  // that stage runs again.
  const faceAttributes = reentrant(tasks.faceAttributes);
  // Needs the CLIP image embedding (from imageAnalysis) to compare photos, so
  // it cascades the same way faceClustering does. It reads whatever
  // photoQualityScore each file has *at the time a cluster's representative is
  // picked* rather than waiting on faceAttributes — a photo whose faces are
  // scored after its cluster already picked a representative keeps that pick
  // until something else re-triggers the cluster (e.g. a manual override).
  const momentClustering = reentrant(tasks.momentClustering);
  const imageAnalysis = reentrant(tasks.imageAnalysis, () => {
    faceClustering.ensure();
    faceAttributes.ensure();
    momentClustering.ensure();
  });
  const exifMetadata = reentrant(tasks.exifMetadata, () => {
    audioTranscription.ensure();
    audioEmbedding.ensure();
  });
  const fileMetadata = reentrant(tasks.fileMetadata);

  // Each metadata/analysis processor polls the DB for outstanding work, so to
  // react to new or changed files we just make sure the entry stages are queued:
  // a mid-run processor picks the work up on its next poll, and a drained one is
  // re-queued by ensure(). The later stages (audio, face clustering) cascade from
  // their upstream stage's onDrain, so they re-run automatically too.
  const queuePipeline = () => {
    fileMetadata.ensure();
    exifMetadata.ensure();
    imageAnalysis.ensure();
  };

  // Boot: run the full-tree scan; when it drains it kicks off the pipeline.
  const fileSystemScan = reentrant(tasks.fileSystemScan, queuePipeline);
  fileSystemScan.ensure();

  return { notifyFilesChanged: queuePipeline };
};
