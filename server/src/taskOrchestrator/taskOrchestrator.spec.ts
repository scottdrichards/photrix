import { describe, expect, it, jest } from "@jest/globals";
import { createTaskOrchestrator } from "./taskOrchestrator.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("taskOrchestrator status reporting", () => {
  it("logs major task lifecycle events", async () => {
    const logger = jest.spyOn(console, "log").mockImplementation(() => {});

    let resolveTask!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveTask = resolve;
    });

    const orchestrator = createTaskOrchestrator();
    orchestrator.addTask(
      {
        name: "Status test task",
        type: "diskInfo",
        start: () => ({
          onComplete: () => completion,
        }),
      },
      "background",
    );

    await wait(40);

    expect(logger).toHaveBeenCalledWith(
      "[TaskOrchestrator] Started (background): Status test task",
    );

    resolveTask();
    await wait(40);
    expect(logger).toHaveBeenCalledWith(
      "[TaskOrchestrator] Completed (background): Status test task",
    );
    logger.mockRestore();
  });

  it("returns status for healthy tasks even when one task status throws", async () => {
    let resolveHealthy!: () => void;
    const healthyCompletion = new Promise<void>((resolve) => {
      resolveHealthy = resolve;
    });

    const orchestrator = createTaskOrchestrator();
    orchestrator.addTask(
      {
        name: "Healthy status task",
        type: "diskInfo",
        start: () => ({
          getStatus: async () => ({
            state: "running",
            itemsProcessed: 2,
            total: 5,
            portionComplete: 0.4,
          }),
          onComplete: () => healthyCompletion,
        }),
      },
      "background",
    );

    let resolveBroken!: () => void;
    const brokenCompletion = new Promise<void>((resolve) => {
      resolveBroken = resolve;
    });
    orchestrator.addTask(
      {
        name: "Broken status task",
        type: "diskInfo",
        start: () => ({
          getStatus: async () => {
            throw new Error("status provider offline");
          },
          onComplete: () => brokenCompletion,
        }),
      },
      "background",
    );

    await wait(30);

    const status = await orchestrator.getBackgroundTaskStatus();
    expect(status).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Healthy status task",
          state: "running",
          itemsProcessed: 2,
          total: 5,
          portionComplete: 0.4,
        }),
        expect.objectContaining({
          name: "Broken status task",
          state: "running",
          description: expect.stringContaining("Status unavailable"),
        }),
      ]),
    );

    resolveHealthy();
    resolveBroken();
    await wait(20);
  });
});
