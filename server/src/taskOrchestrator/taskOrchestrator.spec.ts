import { describe, expect, it, jest } from "@jest/globals";
import { createTaskOrchestrator } from "./taskOrchestrator.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("taskOrchestrator status reporting", () => {
  it("logs active task status snapshots", async () => {
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
          getStatus: async () => ({
            state: "running",
            itemsProcessed: 3,
            total: 10,
            portionComplete: 0.3,
            description: "Indexing files",
          }),
          onComplete: () => completion,
        }),
      },
      "background",
    );

    await wait(260);

    expect(logger).toHaveBeenCalled();
    const lastCall = logger.mock.calls[logger.mock.calls.length - 1]?.[0] as string;
    expect(lastCall).toContain("Task status report");
    expect(lastCall).toContain("1. Background-Status-test-task:");
    expect(lastCall).toContain("30%");
    expect(lastCall).toContain("[---|      ]");
    expect(lastCall).toContain("3/10");
    expect(lastCall).toContain("Indexing files");

    resolveTask();
    await wait(20);
    logger.mockRestore();
  });
});
