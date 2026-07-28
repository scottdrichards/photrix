import { expect, test } from "@playwright/test";

// These run against an isolated server+client (see playwright.config.ts) indexing
// the tiny server/exampleFolder library with auth disabled. They describe what a
// user sees on first load, not implementation details.

test.describe("app shell", () => {
  test("loads straight into the library without a login screen", async ({ page }) => {
    await page.goto("/");

    // Auth is disabled for the test instance, so the app shell renders directly.
    // The theme control is part of that shell (App.tsx: role="switch"/aria-label).
    await expect(page.getByRole("switch", { name: "Theme" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Password" })).toHaveCount(0);
  });

  test("renders thumbnails for the indexed library", async ({ page }) => {
    await page.goto("/");

    const grid = page.getByTestId("thumbnail-grid");
    await expect(grid).toBeVisible();

    // The server indexes exampleFolder asynchronously on boot, so allow generous
    // time for the first thumbnails to appear rather than asserting immediately.
    await expect(grid.getByRole("img").first()).toBeVisible({ timeout: 60_000 });
  });
});
