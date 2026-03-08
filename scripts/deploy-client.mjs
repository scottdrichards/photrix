import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

const getRequiredEnv = (key) => {
  const value = process.env[key]?.trim();
  if (!value) {
      throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

const runScp = (args) => new Promise((resolve, reject) => {
const child = spawn("scp", args, { stdio: "inherit", shell: false });

child.on("error", reject);
child.on("close", (code) => {
    if (code === 0) {
        resolve();
        return;
    }

    reject(new Error(`scp exited with code ${code}`));
});
});


const main = async () => {
  const user = getRequiredEnv("PHOTRIX_DEPLOY_USER");
  const host = getRequiredEnv("PHOTRIX_DEPLOY_HOST");
  const target = getRequiredEnv("PHOTRIX_DEPLOY_TARGET");
  const sourceDir = (process.env.PHOTRIX_DEPLOY_SOURCE_DIR ?? "client/build").trim();
  const port = (process.env.PHOTRIX_DEPLOY_PORT ?? "22").trim();
  const sshKey = process.env.PHOTRIX_DEPLOY_SSH_KEY?.trim();

  if (process.env.PHOTRIX_DEPLOY_PASSWORD?.trim()) {
    console.warn(
      "[deploy] PHOTRIX_DEPLOY_PASSWORD is set but not used by scp. Use SSH keys or interactive password prompt.",
    );
  }

  const absoluteSource = path.resolve(sourceDir);
  await access(absoluteSource);

  const destinationTarget = target.endsWith("/") ? target : `${target}/`;
  const destination = `${user}@${host}:${destinationTarget}`;
  const args = ["-r", "-P", port, ...(sshKey ? ["-i", sshKey] : []), path.join(absoluteSource, "."), destination];

  console.log(`[deploy] Uploading ${absoluteSource} -> ${destination}`);
  await runScp(args);
  console.log("[deploy] Done");
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[deploy] Failed: ${message}`);
  process.exit(1);
});
