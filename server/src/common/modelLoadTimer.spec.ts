import { describe, expect, it } from "@jest/globals";
import { createModelLoadTimer } from "./modelLoadTimer.ts";

describe("createModelLoadTimer (feedback #162)", () => {
  it("reports nothing before any load", () => {
    expect(createModelLoadTimer(() => 0).progress()).toEqual({});
  });

  it("times the current load, then remembers how long it took", () => {
    let clock = 1_000;
    const timer = createModelLoadTimer(() => clock);
    timer.start();
    clock = 13_000;
    expect(timer.progress()).toEqual({ loadingForMs: 12_000 });

    clock = 41_000;
    timer.finish();
    expect(timer.progress()).toEqual({ lastLoadMs: 40_000 });
  });

  it("keeps the first start when asked to start again mid-load", () => {
    let clock = 0;
    const timer = createModelLoadTimer(() => clock);
    timer.start();
    clock = 5_000;
    timer.start();
    clock = 9_000;
    expect(timer.progress().loadingForMs).toBe(9_000);
  });

  it("drops an abandoned load without overwriting the last good time", () => {
    let clock = 0;
    const timer = createModelLoadTimer(() => clock);
    timer.start();
    clock = 30_000;
    timer.finish();
    timer.start();
    clock = 31_000;
    timer.abandon();
    timer.finish();
    expect(timer.progress()).toEqual({ lastLoadMs: 30_000 });
  });
});
