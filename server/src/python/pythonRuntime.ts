import path from "node:path";
import { access, readdir } from "node:fs/promises";

const isWindows = process.platform === "win32";

const canAccess = async (targetPath: string): Promise<boolean> => {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
};

export const resolvePythonCommand = async (): Promise<string> => {
  const fromEnv =
    process.env.PHOTRIX_PYTHON?.trim() ?? process.env.PHOTRIX_PYTHON_EXECUTABLE?.trim();
  if (fromEnv) return fromEnv;

  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, ".venv", "Scripts", "python.exe"),
    path.join(cwd, ".venv", "bin", "python"),
  ];
  for (const candidate of candidates) {
    if (await canAccess(candidate)) return candidate;
  }
  return isWindows ? "python" : "python3";
};

const appendLibraryPath = (existingValue: string | undefined, additions: string[]) => {
  const delimiter = path.delimiter;
  const parts = new Set(
    (existingValue ?? "")
      .split(delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  for (const entry of additions) parts.add(entry);
  return [...parts].join(delimiter);
};

const getBundledCudaLibDirs = async (pythonCommand: string): Promise<string[]> => {
  if (!path.isAbsolute(pythonCommand)) return [];

  const pythonDir = path.dirname(pythonCommand);
  const parentDir = path.basename(path.resolve(pythonDir, ".."));
  if (parentDir !== ".venv") return [];

  const venvRoot = path.resolve(pythonDir, "..");
  const libRoot = path.join(venvRoot, "lib");
  let versions: string[] = [];
  try {
    versions = (await readdir(libRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("python"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const candidates = versions.flatMap((version) => [
    path.join(libRoot, version, "site-packages", "nvidia", "cu13", "lib"),
    path.join(libRoot, version, "site-packages", "nvidia", "cudnn", "lib"),
    path.join(libRoot, version, "site-packages", "nvidia", "cusparselt", "lib"),
    path.join(libRoot, version, "site-packages", "nvidia", "nccl", "lib"),
    path.join(libRoot, version, "site-packages", "nvidia", "nvshmem", "lib"),
  ]);

  const existing = await Promise.all(
    candidates.map(async (candidate) =>
      (await canAccess(candidate)) ? candidate : null,
    ),
  );
  return existing.filter((candidate): candidate is string => candidate !== null);
};

export const buildPythonProcessEnv = async (
  pythonCommand: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> => {
  if (isWindows) return { ...baseEnv };

  const cudaLibDirs = await getBundledCudaLibDirs(pythonCommand);
  if (!cudaLibDirs.length) return { ...baseEnv };

  return {
    ...baseEnv,
    LD_LIBRARY_PATH: appendLibraryPath(baseEnv.LD_LIBRARY_PATH, cudaLibDirs),
  };
};
