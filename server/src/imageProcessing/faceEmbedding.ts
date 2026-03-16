import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PythonInvocation = {
  command: string;
  baseArgs: string[];
};

export type FaceEmbeddingRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type FaceEmbeddingResult = {
  dimensions: FaceEmbeddingRegion;
  embedding: number[];
  quality: {
    overall?: number;
    sharpness?: number;
    effectiveResolution?: number;
  };
};

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "process_face_embeddings.py",
);

let pythonInvocationPromise: Promise<PythonInvocation> | null = null;

const runProbe = async (command: string, args: string[], timeoutMs = 2_000) =>
  await new Promise<{
    ok: boolean;
    stdout: string;
    stderr: string;
  }>((resolveProbe) => {
    const process = spawn(command, args, { windowsHide: true });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      process.kill();
    }, timeoutMs);

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      clearTimeout(timer);
      resolveProbe({ ok: code === 0 && !timedOut, stdout, stderr });
    });

    process.on("error", (error) => {
      clearTimeout(timer);
      resolveProbe({ ok: false, stdout, stderr: `${stderr}${error.message}` });
    });
  });

const isWindowsStorePythonShim = (sysExecutable: string): boolean =>
  /\\AppData\\Local\\Microsoft\\WindowsApps\\python\.exe$/i.test(
    sysExecutable.trim(),
  );

const resolvePythonInvocation = async (): Promise<PythonInvocation> => {
  if (pythonInvocationPromise) {
    return await pythonInvocationPromise;
  }

  pythonInvocationPromise = (async () => {
    const configured = process.env.PHOTRIX_PYTHON?.trim();
    if (configured) {
      return { command: configured, baseArgs: [] };
    }

    // Prefer local virtual environments to keep runtime aligned with installed deps.
    const localVenvCandidates =
      process.platform === "win32"
        ? [
            resolve(process.cwd(), ".venv", "Scripts", "python.exe"),
            resolve(process.cwd(), "..", ".venv", "Scripts", "python.exe"),
          ]
        : [
            resolve(process.cwd(), ".venv", "bin", "python"),
            resolve(process.cwd(), "..", ".venv", "bin", "python"),
          ];

    for (const candidatePath of localVenvCandidates) {
      if (existsSync(candidatePath)) {
        const probe = await runProbe(candidatePath, ["-c", "import sys; print(sys.executable)"]);
        if (probe.ok) {
          return { command: candidatePath, baseArgs: [] };
        }
      }
    }

    const probeCode = "import sys; print(sys.executable)";
    const candidates: PythonInvocation[] =
      process.platform === "win32"
        ? [
            { command: "py", baseArgs: [] },
            { command: "python", baseArgs: [] },
          ]
        : [
            { command: "python3", baseArgs: [] },
            { command: "python", baseArgs: [] },
          ];

    for (const candidate of candidates) {
      const probe = await runProbe(candidate.command, [
        ...candidate.baseArgs,
        "-c",
        probeCode,
      ]);
      if (!probe.ok) {
        continue;
      }

      const sysExecutable = probe.stdout.trim();
      if (
        process.platform === "win32" &&
        candidate.command === "python" &&
        isWindowsStorePythonShim(sysExecutable)
      ) {
        continue;
      }

      return candidate;
    }

    throw new Error("Python is required for face embedding worker but was not found");
  })();

  return await pythonInvocationPromise;
};

const runPythonJson = async (command: string, args: string[]) =>
  await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
    const process = spawn(command, args, { windowsHide: true });

    let stdout = "";
    let stderr = "";

    process.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    process.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    process.on("close", (code) => {
      resolveRun({ code, stdout, stderr });
    });

    process.on("error", (error) => {
      resolveRun({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
  });

export const extractFaceEmbeddingsFromImage = async (options: {
  imagePath: string;
  regions?: FaceEmbeddingRegion[];
}): Promise<FaceEmbeddingResult[]> => {
  const { imagePath, regions } = options;

  const invocation = await resolvePythonInvocation();
  const args = [
    ...invocation.baseArgs,
    scriptPath,
    "--input",
    imagePath,
    ...(regions && regions.length > 0 ? ["--regions", JSON.stringify(regions)] : []),
  ];

  const { code, stdout, stderr } = await runPythonJson(invocation.command, args);

  if (code !== 0) {
    throw new Error(
      `Face embedding worker failed for ${imagePath} (code ${String(code)}): ${stderr || "unknown error"}`,
    );
  }

  const payload = JSON.parse(stdout) as { faces?: FaceEmbeddingResult[] };
  if (!Array.isArray(payload.faces)) {
    return [];
  }

  return payload.faces.filter(
    (face) =>
      typeof face?.dimensions?.x === "number" &&
      typeof face?.dimensions?.y === "number" &&
      typeof face?.dimensions?.width === "number" &&
      typeof face?.dimensions?.height === "number" &&
      Array.isArray(face.embedding),
  );
};
