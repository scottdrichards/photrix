import { expect, test as setup } from "@playwright/test";
import { API_URL } from "../ports";

// The test server starts on an empty index and scans exampleFolder in the
// background. Activity arbitration pauses background work while anyone is
// using the app, and a test's own page requests count as using it — so a test
// that opened the page straight away held the scan off and saw "0 photos"
// for as long as it kept asking. Wait for the scan here, through
// /api/status, which is exempt from arbitration and so doesn't hold it off.

type Status = { backgroundTasks?: { name: string }[] };

setup("the example library is indexed", async ({ request }) => {
  setup.setTimeout(180_000);
  await expect
    .poll(
      async () => {
        const status = (await (await request.get(`${API_URL}/api/status`)).json()) as Status;
        const tasks = status.backgroundTasks ?? [];
        // The scan is the only task queued at boot; once it finishes it hands
        // off to the metadata and analysis passes, so "other tasks, no scan"
        // means it ran rather than that it hasn't been queued yet.
        return tasks.length > 0 && !tasks.some((task) => task.name === "File system scan");
      },
      { timeout: 170_000, intervals: [2_000] },
    )
    .toBe(true);
});
