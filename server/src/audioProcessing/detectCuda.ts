import { spawn } from "node:child_process";
import { buildPythonProcessEnv, resolvePythonCommand } from "../python/pythonRuntime.ts";

export const detectCuda = async (): Promise<boolean> => {
  try {
    const python = await resolvePythonCommand();
    const env = await buildPythonProcessEnv(python);
    return await new Promise<boolean>((resolve) => {
      const child = spawn(
        python,
        ["-c", "import torch; print(1 if torch.cuda.is_available() else 0)"],
        { stdio: ["ignore", "pipe", "ignore"], env },
      );
      let output = "";
      child.stdout.on("data", (d: Buffer) => {
        output += d.toString();
      });
      child.on("close", (code) => resolve(code === 0 && output.trim() === "1"));
      child.on("error", () => resolve(false));
    });
  } catch {
    return false;
  }
};

export const detectOnnxRuntimeCudaProvider = async (): Promise<boolean> => {
  try {
    const python = await resolvePythonCommand();
    const env = await buildPythonProcessEnv(python);
    return await new Promise<boolean>((resolve) => {
      const child = spawn(
        python,
        [
          "-c",
          "import onnxruntime as ort; print(1 if 'CUDAExecutionProvider' in ort.get_available_providers() else 0)",
        ],
        { stdio: ["ignore", "pipe", "ignore"], env },
      );
      let output = "";
      child.stdout.on("data", (d: Buffer) => {
        output += d.toString();
      });
      child.on("close", (code) => resolve(code === 0 && output.trim() === "1"));
      child.on("error", () => resolve(false));
    });
  } catch {
    return false;
  }
};
