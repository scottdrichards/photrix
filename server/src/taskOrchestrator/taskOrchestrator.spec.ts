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

    const orchestrator = createTaskOrchestrator({ isOverloaded: () => false });
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

    const orchestrator = createTaskOrchestrator({ isOverloaded: () => false });
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

describe("taskOrchestrator backoff", () => {
  // A runner that keeps "working" (incrementing) until cancelled, observing
  // pause/resume the way the real processors do at their chunk boundaries.
  const makeTickingTask = (priority?: "high" | "normal") => {
    let paused = false;
    let cancelled = false;
    let ticks = 0;
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const runner = {
      pause: () => {
        paused = true;
      },
      resume: async () => {
        paused = false;
      },
      cancel: () => {
        cancelled = true;
        resolveDone();
      },
      onComplete: async () => {
        while (!cancelled) {
          if (!paused) ticks += 1;
          await wait(5);
        }
      },
    };
    return {
      task: {
        name: `ticker-${priority ?? "normal"}`,
        type: "diskInfo" as const,
        priority,
        start: () => runner,
      },
      ticksSoFar: () => ticks,
      stop: () => {
        cancelled = true;
        resolveDone();
      },
      done,
    };
  };

  it("keeps normal background work progressing under sustained overload (duty cycle, not a hard stop)", async () => {
    const orchestrator = createTaskOrchestrator({
      isOverloaded: () => true,
      dutyOnMs: 15,
      dutyOffMs: 15,
    });
    const ticker = makeTickingTask("normal");
    orchestrator.addTask(ticker.task, "background");

    // Let several duty cycles elapse.
    await wait(120);
    const mid = ticker.ticksSoFar();
    expect(mid).toBeGreaterThan(0); // ran during ON phases despite overload
    await wait(120);
    expect(ticker.ticksSoFar()).toBeGreaterThan(mid); // still advancing
    ticker.stop();
  });

  it("runs high-priority work full speed under overload, while normal work backs off", async () => {
    const orchestrator = createTaskOrchestrator({
      isOverloaded: () => true,
      dutyOnMs: 10,
      dutyOffMs: 40, // long OFF so a backed-off task ticks noticeably less
    });
    const high = makeTickingTask("high");
    const normal = makeTickingTask("normal");
    orchestrator.addTask(high.task, "background");
    orchestrator.addTask(normal.task, "background");

    await wait(150);
    // High priority is exempt from the load-based duty cycle, so it should have
    // accumulated clearly more ticks than the normal task that keeps pausing.
    expect(high.ticksSoFar()).toBeGreaterThan(normal.ticksSoFar());
    high.stop();
    normal.stop();
  });

  it("admits a blocking task immediately even while background work holds the resource budget", async () => {
    const orchestrator = createTaskOrchestrator({ isOverloaded: () => false });

    // A never-ending background processor that holds the full CPU budget, the
    // way image analysis / audio workers do for their entire run.
    let stopBackground!: () => void;
    const backgroundDone = new Promise<void>((resolve) => {
      stopBackground = resolve;
    });
    orchestrator.addTask(
      {
        name: "CPU-hogging background processor",
        type: "imageAnalysis", // cpu: 0.75
        start: () => ({ onComplete: () => backgroundDone }),
      },
      "background",
    );

    await wait(30);

    // A user opens a video: HLS encode is queued as a blocking videoConversion
    // (gpu: 0.5, cpu: 0.5). cpu 0.75 + 0.5 > 1 would gate it under the budget,
    // but blocking tasks must run promptly regardless.
    let started = false;
    orchestrator.addTask(
      {
        name: "HLS generation",
        type: "videoConversion",
        start: () => {
          started = true;
          return { onComplete: async () => {} };
        },
      },
      "blocking",
    );

    await wait(30);
    expect(started).toBe(true);
    stopBackground();
    await wait(20);
  });

  it("yields even high-priority work briefly to a user request", async () => {
    let clock = 1_000_000;
    const orchestrator = createTaskOrchestrator({
      isOverloaded: () => false,
      now: () => clock,
      dutyOnMs: 10,
      dutyOffMs: 10,
    });
    const high = makeTickingTask("high");
    orchestrator.addTask(high.task, "background");

    // No pressure yet -> runs full speed.
    await wait(40);
    const beforeRequest = high.ticksSoFar();
    expect(beforeRequest).toBeGreaterThan(0);

    // A user request makes the user "active"; high-priority work now duty-cycles.
    orchestrator.noteUserActivity();
    await wait(40);
    const duringActivity = high.ticksSoFar() - beforeRequest;

    // Let the activity window lapse (cooldown is 2s); full speed resumes.
    clock += 5_000;
    await wait(40);
    const afterActivity = high.ticksSoFar() - beforeRequest - duringActivity;

    // It still progressed during activity (a little), but less than when idle.
    expect(duringActivity).toBeGreaterThan(0);
    expect(afterActivity).toBeGreaterThan(duringActivity);
    high.stop();
  });
});
