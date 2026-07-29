import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Reset the throwaway index before every run so the suite starts from a clean
// re-scan of exampleFolder (matches the repo's "rebuild, don't migrate" data
// policy and avoids stale-schema surprises across branches). We delete only the
// SQLite index and the derived thumbnail cache — NOT the downloaded ML models
// under .cache-e2e/huggingface, which are expensive to refetch each run.
export default async function globalSetup(): Promise<void> {
  const testCache = resolve(here, "..", "server", ".cache-e2e");
  await Promise.all(
    ["index.db", "index.db-wal", "index.db-shm", "media"].map((entry) =>
      rm(resolve(testCache, entry), { recursive: true, force: true }),
    ),
  );
}
