import path from "node:path";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";

const resolvePythonCommand = async (): Promise<string> => {
  const fromEnv = process.env.PHOTRIX_PYTHON?.trim() ?? process.env.PHOTRIX_PYTHON_EXECUTABLE?.trim();
  if (fromEnv) return fromEnv;
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, ".venv", "Scripts", "python.exe"),
    path.join(cwd, ".venv", "bin", "python"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return isWindows ? "python" : "python3";
};

export const detectCuda = async (): Promise<boolean> => {
  try {
    const python = await resolvePythonCommand();
    return await new Promise<boolean>((resolve) => {
      const child = spawn(
        python,
        ["-c", "import torch; print(1 if torch.cuda.is_available() else 0)"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      let output = "";
      child.stdout.on("data", (d: Buffer) => { output += d.toString(); });
      child.on("close", (code) => resolve(code === 0 && output.trim() === "1"));
      child.on("error", () => resolve(false));
    });
  } catch {
    return false;
  }
};
