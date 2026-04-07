import { describe, expect, it } from "@jest/globals";
import { isBackgroundTasksEnabled, setBackgroundTasksEnabled } from "./backgroundTasksControl.ts";

describe("backgroundTasksControl", () => {
  it("starts with background tasks enabled", () => {
    expect(isBackgroundTasksEnabled()).toBe(true);
  });

  it("allows toggling the background task flag", () => {
    setBackgroundTasksEnabled(false);
    expect(isBackgroundTasksEnabled()).toBe(false);

    setBackgroundTasksEnabled(true);
    expect(isBackgroundTasksEnabled()).toBe(true);
  });
});
