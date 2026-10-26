import { describe, expect, it } from "vitest";
import { describeHoldup } from "./taskHoldup";

describe("describeHoldup", () => {
  it("flags GPU contention", () => {
    expect(describeHoldup({ reason: "gpu-lent" })).toEqual({
      text: "Paused: GPU lent to video playback",
      gpu: true,
    });
    expect(describeHoldup({ reason: "faces-on-cpu" }).gpu).toBe(true);
    expect(describeHoldup({ reason: "user-active" }).gpu).toBe(false);
  });

  it("names the budgets a queued task waits for, and who holds them", () => {
    expect(
      describeHoldup({
        reason: "waiting-for-resources",
        resources: ["gpu", "cpu"],
        heldBy: ["Image analysis", "Audio embedding (CLAP)"],
      }),
    ).toEqual({
      text: "Waiting for the GPU and CPU (in use by Image analysis and Audio embedding (CLAP))",
      gpu: true,
    });
    expect(
      describeHoldup({
        reason: "waiting-for-resources",
        resources: ["memoryMB"],
        heldBy: [],
      }),
    ).toEqual({ text: "Waiting for memory", gpu: false });
  });
});
