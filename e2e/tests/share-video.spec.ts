import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

// What someone sees when they save or share a video at a smaller size. The
// fixture is an HEVC clip, the kind a phone records and many chat apps and
// older devices can't play, so "smaller" has to mean a real converted MP4 and
// not the original file under a different name.

const VIDEO = "big_buck_bunny_20s_h265.mp4";

test.describe("sharing a video", () => {
  test("downloads a converted MP4 when a smaller size is chosen", async ({ page }) => {
    // Encoding happens on request; allow for the software fallback.
    test.setTimeout(180_000);
    await page.goto("/");

    const tile = page.getByLabel(VIDEO, { exact: true });
    await expect(tile).toBeVisible({ timeout: 60_000 });
    await tile.click();

    await page.getByRole("button", { name: "Download item" }).click();
    const smaller = page.getByRole("button", { name: /Smaller size/ });
    await expect(smaller).toContainText("MP4 at 720p");

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 150_000 }),
      smaller.click(),
    ]);

    expect(download.suggestedFilename()).toBe("big_buck_bunny_20s_h265.mp4");
    expect(download.url()).toContain("representation=shareMp4");
    expect(download.url()).toContain("size=720");

    const path = await download.path();
    const bytes = await readFile(path);
    // An MP4 starts with an ftyp box; a failed encode would be a JSON error.
    expect(bytes.subarray(4, 8).toString("latin1")).toBe("ftyp");
    // faststart puts the moov index ahead of the media data, so a phone can
    // start playing before the whole file has arrived.
    expect(bytes.indexOf("moov")).toBeLessThan(bytes.indexOf("mdat"));
  });
});
