import { describe, expect, it, jest } from "@jest/globals";

// The orchestrator logs lifecycle events through the structured (pino) logger,
// not console.log, so mock the logger module to observe those calls. getLogger
// returns a child logger; we hand back a single spyable stub for every module.
const mockLog = {
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
};

jest.unstable_mockModule("../observability/logger.ts", () => ({
  getLogger: () => mockLog,
  logger: mockLog,
}));

const { createTaskOrchestrator } = await import("./taskOrchestrator.ts");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("taskOrchestrator status reporting", () => {
  it("logs major task lifecycle events", async () => {
    mockLog.info.mockClear();

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

    expect(mockLog.info).toHaveBeenCalledWith(
      { queue: "background", task: "Status test task" },
      "Started",
    );

    resolveTask();
    await wait(40);
    expect(mockLog.info).toHaveBeenCalledWith(
      { queue: "background", task: "Status test task" },
      "Completed",
    );
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
        // A failing status read must never break the payload or surface an
        // error to the UI: the task still appears as running, just without
        // progress details (we have no prior status to fall back to here).
        expect.objectContaining({
          name: "Broken status task",
          state: "running",
        }),
      ]),
    );

    const brokenStatus = status.find((s) => s.name === "Broken status task");
    expect(brokenStatus?.description).toBeUndefined();

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

  it("fully yields even high-priority work to a user request, then resumes when idle", async () => {
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

    // A user request makes the user "active"; ALL background work (even the
    // high-priority scan) is fully stopped so the request gets the box.
    orchestrator.noteUserActivity();
    await wait(40);
    const duringActivity = high.ticksSoFar() - beforeRequest;
    // At most a single in-flight tick before the pause takes hold.
    expect(duringActivity).toBeLessThanOrEqual(1);

    // Let the activity window lapse (cooldown is 2s); full speed resumes.
    clock += 5_000;
    await wait(40);
    const afterActivity = high.ticksSoFar() - beforeRequest - duringActivity;
    expect(afterActivity).toBeGreaterThan(0);
    high.stop();
  });

  it("suspends compute workers while a request is in flight and resumes when idle", async () => {
    let clock = 1_000_000;
    const suspend = jest.fn();
    const resume = jest.fn();
    const orchestrator = createTaskOrchestrator({
      isOverloaded: () => false,
      now: () => clock,
      dutyOnMs: 10,
      dutyOffMs: 10,
      computeThrottle: { suspend, resume },
    });

    orchestrator.noteUserActivity();
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();

    // Window lapses -> workers thaw exactly once.
    clock += 5_000;
    await wait(40);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("keeps compute workers suspended for the whole bracketed request, past the cooldown", async () => {
    let clock = 1_000_000;
    const suspend = jest.fn();
    const resume = jest.fn();
    const orchestrator = createTaskOrchestrator({
      isOverloaded: () => false,
      now: () => clock,
      dutyOnMs: 10,
      dutyOffMs: 10,
      computeThrottle: { suspend, resume },
    });

    orchestrator.beginUserRequest();
    expect(suspend).toHaveBeenCalledTimes(1);

    // Advance well past the 2s activity cooldown while the request is still in
    // flight. A one-shot cooldown would have thawed the workers here; the bracket
    // must keep them frozen because the request has not finished.
    clock += 10_000;
    await wait(40);
    expect(resume).not.toHaveBeenCalled();

    // Request ends -> trailing cooldown -> workers thaw exactly once.
    orchestrator.endUserRequest();
    clock += 5_000;
    await wait(40);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("stays suspended until the last overlapping request finishes", async () => {
    let clock = 1_000_000;
    const suspend = jest.fn();
    const resume = jest.fn();
    const orchestrator = createTaskOrchestrator({
      isOverloaded: () => false,
      now: () => clock,
      dutyOnMs: 10,
      dutyOffMs: 10,
      computeThrottle: { suspend, resume },
    });

    orchestrator.beginUserRequest();
    orchestrator.beginUserRequest();
    expect(suspend).toHaveBeenCalledTimes(1);

    // First of two concurrent requests ends; one is still in flight.
    orchestrator.endUserRequest();
    clock += 10_000;
    await wait(40);
    expect(resume).not.toHaveBeenCalled();

    // Last request ends -> cooldown lapses -> thaw.
    orchestrator.endUserRequest();
    clock += 5_000;
    await wait(40);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("does not freeze compute workers for the overload duty cycle (work keeps trickling)", async () => {
    const suspend = jest.fn();
    const resume = jest.fn();
    const orchestrator = createTaskOrchestrator({
      isOverloaded: () => true,
      dutyOnMs: 15,
      dutyOffMs: 15,
      computeThrottle: { suspend, resume },
    });
    const ticker = makeTickingTask("normal");
    orchestrator.addTask(ticker.task, "background");

    await wait(120);
    // Overload backs off via the duty cycle, never by SIGSTOP — the workers must
    // stay thawed so background work can keep making progress.
    expect(suspend).not.toHaveBeenCalled();
    ticker.stop();
  });
});
