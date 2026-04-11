import { spawn } from "child_process";

let cudaPromise: Promise<boolean> | null = null;

const detectCuda = (): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const process = spawn("ffmpeg", [
      "-hide_banner",
      "-init_hw_device",
      "cuda",
      "-f",
      "lavfi",
      "-i",
      "nullsrc",
      "-t",
      "0",
      "-f",
      "null",
      "-",
    ]);

    let stderr = "";

    process.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    process.on("close", (code) => {
      const available =
        code === 0 &&
        !stderr.includes("Cannot load nvcuda.dll") &&
        !stderr.includes("Could not dynamically load CUDA");
      console.log(`[CUDA] Hardware acceleration ${available ? "available" : "not available"}`);
      resolve(available);
    });

    process.on("error", () => {
      resolve(false);
    });
  });

export const isCudaAvailable = (): Promise<boolean> => {
  if (!cudaPromise) {
    cudaPromise = detectCuda();
  }
  return cudaPromise;
};

export const resetCudaAvailabilityForTests = (value: boolean) => {
  cudaPromise = Promise.resolve(value);
};
