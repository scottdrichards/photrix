import { describe, expect, it, jest } from "@jest/globals";

jest.unstable_mockModule("../observability/logger.ts", () => ({
  getLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const { registerComputeWorker, withForegroundWorker, awaitForegroundIdle } = await import(
  "./computeWorkers.ts"
);

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("computeWorkers foreground-idle gate", () => {
  it("resolves immediately when no foreground call is in flight", async () => {
    registerComputeWorker("idle-worker", () => null);
    let resolved = false;
    void awaitForegroundIdle("idle-worker").then(() => {
      resolved = true;
    });
    await tick();
    expect(resolved).toBe(true);
  });

  it("blocks background work until the foreground call completes", async () => {
    registerComputeWorker("busy-worker", () => null);

    let releaseForeground!: () => void;
    const foregroundBody = new Promise<void>((resolve) => {
      releaseForeground = resolve;
    });
    const foreground = withForegroundWorker("busy-worker", () => foregroundBody);

    // Background work requested while the foreground call is in flight must wait.
    let backgroundProceeded = false;
    const background = awaitForegroundIdle("busy-worker").then(() => {
      backgroundProceeded = true;
    });

    await tick();
    expect(backgroundProceeded).toBe(false);

    releaseForeground();
    await foreground;
    await background;
    expect(backgroundProceeded).toBe(true);
  });

  it("keeps the gate closed until the last concurrent foreground call finishes", async () => {
    registerComputeWorker("multi-worker", () => null);

    let releaseA!: () => void;
    let releaseB!: () => void;
    const a = withForegroundWorker("multi-worker", () => new Promise<void>((r) => (releaseA = r)));
    const b = withForegroundWorker("multi-worker", () => new Promise<void>((r) => (releaseB = r)));

    let backgroundProceeded = false;
    void awaitForegroundIdle("multi-worker").then(() => {
      backgroundProceeded = true;
    });

    releaseA();
    await a;
    await tick();
    // One foreground call is still in flight, so the gate stays closed.
    expect(backgroundProceeded).toBe(false);

    releaseB();
    await b;
    await tick();
    expect(backgroundProceeded).toBe(true);
  });
});
