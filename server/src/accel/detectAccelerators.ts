import { spawn } from "node:child_process";
import path from "node:path";
import { buildPythonProcessEnv, resolvePythonCommand } from "../python/pythonRuntime.ts";

/**
 * Which compute devices the Python ML stack can use on this machine, from one
 * run of `python/accel_probe.py` at startup. Every worker is configured from
 * this rather than probing the hardware itself.
 *
 * `torch.device` has already run a real op (see `python/accel.py`), so a card
 * whose kernels the installed torch build lacks reports `cpu` with the reason in
 * `rejected`, not `cuda`.
 */
export type AcceleratorReport = {
  platform: string | null;
  torch: {
    /** `cuda` (NVIDIA, or AMD under ROCm), `xpu` (Intel), `mps` (Apple) or `cpu`. */
    device: string;
    /** `rocm` when `device` is `cuda` on an AMD card; otherwise equal to `device`. */
    backend: string;
    version: string | null;
    /** Devices tried and not used, with why. */
    rejected: Record<string, string>;
    error: string | null;
  };
  ort: {
    /** The ONNX Runtime execution provider the face models should use. */
    provider: string;
    available: string[];
    version: string | null;
    error: string | null;
  };
};

export const CPU_PROVIDER = "CPUExecutionProvider";
export const CUDA_PROVIDER = "CUDAExecutionProvider";

const PROBE_SCRIPT = path.resolve(process.cwd(), "python", "accel_probe.py");

/**
 * A cold `import torch` plus a first CUDA context can take tens of seconds on a
 * loaded box. Past this, startup carries on with CPU rather than hanging.
 */
const PROBE_TIMEOUT_MS = 180_000;

export const cpuOnlyReport = (reason: string): AcceleratorReport => ({
  platform: null,
  torch: { device: "cpu", backend: "cpu", version: null, rejected: {}, error: reason },
  ort: { provider: CPU_PROVIDER, available: [], version: null, error: reason },
});

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const asStringRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
};

/**
 * Parse the probe's stdout. It prints one JSON line; anything before it is
 * noise from a package import. Fields that are missing or the wrong shape fall
 * back to CPU, field by field.
 */
export const parseAcceleratorReport = (stdout: string): AcceleratorReport => {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .at(-1);
  if (!line) return cpuOnlyReport("accelerator probe printed no report");

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch (err) {
    return cpuOnlyReport(`accelerator probe printed invalid JSON: ${String(err)}`);
  }

  const torch = (raw.torch ?? {}) as Record<string, unknown>;
  const ort = (raw.ort ?? {}) as Record<string, unknown>;
  const device = asString(torch.device)?.toLowerCase() ?? "cpu";
  return {
    platform: asString(raw.platform),
    torch: {
      device,
      backend: asString(torch.backend)?.toLowerCase() ?? device,
      version: asString(torch.version),
      rejected: asStringRecord(torch.rejected),
      error: asString(torch.error),
    },
    ort: {
      provider: asString(ort.provider) ?? CPU_PROVIDER,
      available: Array.isArray(ort.available)
        ? ort.available.filter((p): p is string => typeof p === "string")
        : [],
      version: asString(ort.version),
      error: asString(ort.error),
    },
  };
};

export const detectAccelerators = async (
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<AcceleratorReport> => {
  let python: string;
  let env: NodeJS.ProcessEnv;
  try {
    python = await resolvePythonCommand();
    env = await buildPythonProcessEnv(python);
  } catch (err) {
    return cpuOnlyReport(`no python interpreter: ${String(err)}`);
  }

  return new Promise<AcceleratorReport>((resolve) => {
    const child = spawn(python, [PROBE_SCRIPT], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      cwd: path.dirname(PROBE_SCRIPT),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (report: AcceleratorReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(report);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(cpuOnlyReport(`accelerator probe timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    child.on("error", (err) => finish(cpuOnlyReport(`accelerator probe failed: ${err.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(
          cpuOnlyReport(`accelerator probe exited ${code}: ${stderr.trim().slice(-500)}`),
        );
        return;
      }
      finish(parseAcceleratorReport(stdout));
    });
  });
};
