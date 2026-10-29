import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLabMedia } from "./media.ts";

const here = dirname(fileURLToPath(import.meta.url));

export default async function globalSetup(): Promise<void> {
  ensureLabMedia(resolve(process.env.PHOTRIX_LAB_MEDIA ?? resolve(here, ".media")));
  // Start every run from an empty index and no leftover HLS output.
  await rm(resolve(here, ".cache"), { recursive: true, force: true });
  await rm(resolve(here, "..", "test-results", "playback-lab", "results"), {
    recursive: true,
    force: true,
  });
}
