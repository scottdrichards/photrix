import {
  acquireThumbnailSlot,
  resetThumbnailQueue,
  thumbnailQueueStats,
} from "./MapFilter.thumbnailQueue";

const MAX_CONCURRENT_LOADS = 4;

describe("thumbnail load queue", () => {
  beforeEach(() => {
    resetThumbnailQueue();
  });

  it("starts loads immediately while capacity remains", () => {
    const started: number[] = [];
    for (let index = 0; index < MAX_CONCURRENT_LOADS; index += 1) {
      acquireThumbnailSlot(() => started.push(index));
    }
    expect(started).toEqual([0, 1, 2, 3]);
    expect(thumbnailQueueStats().activeLoads).toBe(MAX_CONCURRENT_LOADS);
  });

  it("holds the overflow back until a slot frees", () => {
    const releases = Array.from({ length: MAX_CONCURRENT_LOADS }, () =>
      acquireThumbnailSlot(() => {}),
    );
    let lateStarted = false;
    acquireThumbnailSlot(() => {
      lateStarted = true;
    });

    expect(lateStarted).toBe(false);
    expect(thumbnailQueueStats().waitingCount).toBe(1);

    releases[0]();
    expect(lateStarted).toBe(true);
  });

  it("never issues a request for a marker that left before its turn", () => {
    const releases = Array.from({ length: MAX_CONCURRENT_LOADS }, () =>
      acquireThumbnailSlot(() => {}),
    );
    let started = false;
    const revoke = acquireThumbnailSlot(() => {
      started = true;
    });

    // The marker pans out of view while still queued.
    revoke();
    releases[0]();

    expect(started).toBe(false);
    expect(thumbnailQueueStats().waitingCount).toBe(0);
  });

  it("is idempotent so a double release cannot inflate capacity", () => {
    const release = acquireThumbnailSlot(() => {});
    release();
    release();
    expect(thumbnailQueueStats().activeLoads).toBe(0);

    const started: number[] = [];
    for (let index = 0; index < MAX_CONCURRENT_LOADS + 1; index += 1) {
      acquireThumbnailSlot(() => started.push(index));
    }
    // The extra one must still be gated, not admitted by a miscounted slot.
    expect(started).toHaveLength(MAX_CONCURRENT_LOADS);
  });

  it("drains a backlog in order as slots free", () => {
    const releases = Array.from({ length: MAX_CONCURRENT_LOADS }, () =>
      acquireThumbnailSlot(() => {}),
    );
    const started: string[] = [];
    acquireThumbnailSlot(() => started.push("first"));
    acquireThumbnailSlot(() => started.push("second"));

    releases[0]();
    expect(started).toEqual(["first"]);
    releases[1]();
    expect(started).toEqual(["first", "second"]);
  });
});
