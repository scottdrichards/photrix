import { expect, test } from "@playwright/test";

// These run against an isolated server+client (see playwright.config.ts) indexing
// the tiny server/exampleFolder library with auth disabled. They describe what a
// user sees on first load, not implementation details.

test.describe("app shell", () => {
  test("loads straight into the library without a login screen", async ({ page }) => {
    await page.goto("/");

    // Auth is disabled for the test instance, so the app shell renders directly.
    // The theme control lives in the Account panel (feedback #198). Opening it
    // fetches /api/account; wait for that answer before asserting, because a
    // 401 there swaps the app for the login screen. Asserting earlier let the
    // test pass or fail on timing instead of on the app's behaviour.
    const accountLoaded = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/account",
    );
    await page.getByTitle("Account").click();
    await accountLoaded;
    await expect(page.getByRole("switch", { name: "Theme" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Password" })).toHaveCount(0);
  });

  test("renders thumbnails for the indexed library", async ({ page }) => {
    // The server indexes exampleFolder in the background after boot, and only
    // once its search-model warmup releases (up to a minute, longer than the
    // first page load). The grid doesn't poll for new files, so reload until a
    // load finds them, as a user arriving later would. Reloads are spaced out
    // because every API request briefly pauses background work.
    test.setTimeout(180_000);
    const grid = page.getByTestId("thumbnail-grid");
    await expect(async () => {
      await page.goto("/");
      await expect(grid).toBeVisible();
      await expect(grid.getByRole("img").first()).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 150_000, intervals: [10_000] });
  });
});
