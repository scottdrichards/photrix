import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

export async function waitForCondition<T>(
  fn: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (predicate(value)) {
      return value;
    }
    await delay(intervalMs);
  }
  throw new Error("Condition not met within timeout");
}

export async function createExampleWorkspace(
  prefix = "photrix-indexer-",
): Promise<string> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const source = path.resolve(__dirname, "../exampleFolder");
  const destination = await mkdtemp(path.join(tmpdir(), prefix));
  await cp(source, destination, { recursive: true });
  return destination;
}

export function resolveWorkspacePath(workspace: string, relative: string): string {
  return path.resolve(workspace, relative.split("/").join(path.sep));
}
