#!/usr/bin/env node
// Installs the Python ML stack for whatever GPU this machine has, and reports
// what the server will actually use.
//
//   node scripts/python-env.mjs install [--profile auto|<name>] [--dry-run]
//   node scripts/python-env.mjs report
//   node scripts/python-env.mjs list
//
// `install` installs python/requirements.txt (the portable CPU base), then the
// profile's torch build and its one onnxruntime package, then runs the same
// accelerator probe the server runs at startup and fails if the profile's GPU
// isn't in use. `report` runs only the probe.
//
// Uses $PHOTRIX_PYTHON, else server/.venv, else python3/python, the same order
// the server uses.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PYTHON_DIR = path.join(SERVER_DIR, "python");
const REQUIREMENTS = path.join(PYTHON_DIR, "requirements.txt");
const PROBE = path.join(PYTHON_DIR, "accel_probe.py");

// Keep in step with python/requirements.txt.
const TORCH = "2.9.1";
const TORCHVISION = "0.24.1";
const ORT_CPU = "onnxruntime==1.27.0";
const PYTORCH_INDEX = "https://download.pytorch.org/whl";

// Every onnxruntime build installs into the same `onnxruntime/` import
// directory, so exactly one may be installed. Leaving two in place silently
// gives you whichever was written last.
export const ORT_PACKAGES = [
  "onnxruntime",
  "onnxruntime-gpu",
  "onnxruntime-directml",
  "onnxruntime-openvino",
];

/**
 * `torchIndex`: the PyTorch wheel index whose build replaces PyPI's default.
 * `ort`: the one onnxruntime package to install.
 * `expect`: what the probe must report afterwards, or the install fails.
 * `verified`: whether this profile has been run on real hardware.
 */
export const PROFILES = {
  cpu: {
    summary: "CPU only, any OS",
    ort: ORT_CPU,
    expect: { torch: "cpu", provider: "CPUExecutionProvider" },
    verified: true,
  },
  mac: {
    // PyPI's macOS arm64 torch wheel has MPS, and the macOS onnxruntime wheel
    // has CoreML, so the base install already is this profile.
    summary: "Apple Silicon: CLIP/CLAP on MPS, faces on CoreML",
    ort: ORT_CPU,
    expect: { torch: "mps", provider: "CoreMLExecutionProvider" },
    verified: false,
  },
  cuda: {
    // CUDA 13 builds: onnxruntime-gpu 1.28+ links CUDA 13, so torch must ship
    // CUDA 13 libraries too or the face provider fails to import. CUDA 13 has
    // no kernels below compute capability 7.5, hence cuda-legacy.
    summary: "NVIDIA, compute capability 7.5+ (RTX 20xx / GTX 16xx and newer)",
    torchIndex: "cu130",
    ort: "onnxruntime-gpu==1.31.1",
    expect: { torch: "cuda", provider: "CUDAExecutionProvider" },
    verified: false,
  },
  "cuda-legacy": {
    // For Pascal and Volta (e.g. Quadro P520, GTX 10xx). Current torch CUDA
    // wheels dropped these kernels: an unpinned torch reports
    // cuda.is_available() True and then fails every op with "no kernel image is
    // available". cu126 is the newest index that still runs sm_6x/sm_70, and the
    // oldest with Python 3.14 wheels. onnxruntime-gpu 1.26.0 is the last
    // CUDA 12 build with a cp314 wheel; 1.28+ link CUDA 13 and fail to import
    // here with "libcudart.so.13". cuDNN stays at torch's 9.10.2.21: 9.27 fails
    // the first convolution on Pascal with CUDNN_BACKEND_API_FAILED.
    summary: "NVIDIA, compute capability below 7.5 (Pascal/Volta: GTX 10xx, Quadro P)",
    torchIndex: "cu126",
    ort: "onnxruntime-gpu==1.26.0",
    extra: ["nvidia-cudnn-cu12==9.10.2.21"],
    expect: { torch: "cuda", provider: "CUDAExecutionProvider" },
    verified: true,
  },
  rocm: {
    // ROCm torch reports itself as `cuda`. There is no ROCm onnxruntime on
    // PyPI (AMD publishes one separately), so faces stay on CPU unless you
    // install that by hand.
    summary: "AMD on Linux: CLIP/CLAP via ROCm, faces on CPU",
    torchIndex: "rocm6.4",
    ort: ORT_CPU,
    expect: { torch: "cuda", provider: "CPUExecutionProvider" },
    verified: false,
  },
  xpu: {
    // onnxruntime-openvino would put the faces on the Intel GPU, but it has no
    // Python 3.14 build yet.
    summary: "Intel Arc / Core Ultra GPU: CLIP/CLAP on XPU, faces on CPU",
    torchIndex: "xpu",
    ort: ORT_CPU,
    expect: { torch: "xpu", provider: "CPUExecutionProvider" },
    verified: false,
  },
  directml: {
    // torch-directml lags torch releases too far to rely on, so CLIP/CLAP stay
    // on CPU here; the face models get any DirectX 12 GPU.
    summary: "Windows on AMD or Intel: faces on DirectML, CLIP/CLAP on CPU",
    ort: "onnxruntime-directml==1.24.4",
    expect: { torch: "cpu", provider: "DmlExecutionProvider" },
    verified: false,
  },
};

/**
 * Pick a profile from what's visible on the machine.
 * `facts`: { platform, arch, nvidiaComputeCap: number|null, hasRocm: boolean }.
 * Intel's `xpu` is never picked automatically: most Intel iGPUs aren't
 * supported by it, and telling them apart needs more than a vendor ID.
 */
export const chooseProfile = ({ platform, arch, nvidiaComputeCap, hasRocm }) => {
  if (platform === "darwin") return arch === "arm64" ? "mac" : "cpu";
  if (nvidiaComputeCap != null) return nvidiaComputeCap >= 7.5 ? "cuda" : "cuda-legacy";
  if (platform === "linux" && hasRocm) return "rocm";
  if (platform === "win32") return "directml";
  return "cpu";
};

/** The first GPU's compute capability from `nvidia-smi` output, or null. */
export const parseComputeCap = (stdout) => {
  const first = String(stdout ?? "").trim().split(/\r?\n/)[0]?.trim();
  const value = Number.parseFloat(first ?? "");
  return Number.isFinite(value) ? value : null;
};

/** The pip commands for a profile, as argv arrays (after the python binary). */
export const planInstall = (name) => {
  const profile = PROFILES[name];
  if (!profile) throw new Error(`unknown profile "${name}"`);
  const steps = [["-m", "pip", "install", "-r", REQUIREMENTS]];
  if (profile.torchIndex) {
    const tag = profile.torchIndex;
    steps.push([
      "-m",
      "pip",
      "install",
      `torch==${TORCH}+${tag}`,
      `torchvision==${TORCHVISION}+${tag}`,
      "--extra-index-url",
      `${PYTORCH_INDEX}/${tag}`,
    ]);
  }
  steps.push(["-m", "pip", "uninstall", "-y", ...ORT_PACKAGES]);
  steps.push(["-m", "pip", "install", profile.ort, ...(profile.extra ?? [])]);
  return steps;
};

/** Ways the probe's report falls short of what a profile promised. */
export const checkReport = (name, report) => {
  const expect = PROFILES[name]?.expect;
  if (!expect) return [];
  const problems = [];
  const torch = report?.torch?.device ?? "missing";
  const provider = report?.ort?.provider ?? "missing";
  if (torch !== expect.torch) {
    const why = report?.torch?.rejected?.[expect.torch] ?? report?.torch?.error;
    problems.push(`torch is on ${torch}, expected ${expect.torch}${why ? ` (${why})` : ""}`);
  }
  if (provider !== expect.provider) {
    problems.push(
      `face models get ${provider}, expected ${expect.provider}${report?.ort?.error ? ` (${report.ort.error})` : ""}`,
    );
  }
  return problems;
};

const resolvePython = () => {
  const fromEnv = process.env.PHOTRIX_PYTHON?.trim() || process.env.PHOTRIX_PYTHON_EXECUTABLE?.trim();
  if (fromEnv) return fromEnv;
  for (const candidate of [
    path.join(SERVER_DIR, ".venv", "Scripts", "python.exe"),
    path.join(SERVER_DIR, ".venv", "bin", "python"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === "win32" ? "python" : "python3";
};

const gatherFacts = () => {
  const smi = spawnSync("nvidia-smi", ["--query-gpu=compute_cap", "--format=csv,noheader"], {
    encoding: "utf8",
  });
  const hasRocm =
    process.platform === "linux" &&
    (existsSync("/dev/kfd") || spawnSync("rocminfo", [], { stdio: "ignore" }).status === 0);
  return {
    platform: process.platform,
    arch: process.arch,
    nvidiaComputeCap: smi.status === 0 ? parseComputeCap(smi.stdout) : null,
    hasRocm,
  };
};

const runProbe = (python) => {
  const result = spawnSync(python, [PROBE], { encoding: "utf8", cwd: PYTHON_DIR });
  const line = (result.stdout ?? "")
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .at(-1);
  if (result.status !== 0 || !line) {
    throw new Error(`accelerator probe failed: ${(result.stderr ?? "").trim().slice(-800)}`);
  }
  return JSON.parse(line);
};

const parseArgs = (argv) => {
  const args = { command: argv[0] ?? "install", profile: "auto", dryRun: false };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--") continue; // `bun run <script> -- --profile x` passes it through
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--profile") args.profile = argv[++i];
    else if (argv[i].startsWith("--profile=")) args.profile = argv[i].slice("--profile=".length);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  const python = resolvePython();

  if (args.command === "list") {
    for (const [name, p] of Object.entries(PROFILES)) {
      console.log(`${name.padEnd(12)} ${p.verified ? "          " : "(untested)"} ${p.summary}`);
    }
    return 0;
  }

  if (args.command === "report") {
    console.log(JSON.stringify(runProbe(python), null, 2));
    return 0;
  }

  if (args.command !== "install") throw new Error(`unknown command ${args.command}`);

  const facts = gatherFacts();
  const name = args.profile === "auto" ? chooseProfile(facts) : args.profile;
  const profile = PROFILES[name];
  if (!profile) throw new Error(`unknown profile "${name}"; try: ${Object.keys(PROFILES).join(", ")}`);
  console.log(
    `profile: ${name}${args.profile === "auto" ? " (auto)" : ""} - ${profile.summary}` +
      `${profile.verified ? "" : " [not yet verified on real hardware]"}`,
  );
  console.log(`python:  ${python}`);

  for (const step of planInstall(name)) {
    console.log(`\n$ ${python} ${step.join(" ")}`);
    if (args.dryRun) continue;
    const result = spawnSync(python, step, { stdio: "inherit" });
    if (result.status !== 0) {
      console.error(`step failed (exit ${result.status})`);
      return 1;
    }
  }
  if (args.dryRun) return 0;

  const report = runProbe(python);
  console.log(`\n${JSON.stringify(report, null, 2)}`);
  const problems = checkReport(name, report);
  if (problems.length) {
    console.error(`\nInstalled, but not running as profile "${name}" promised:`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  console.log(`\nOK: torch on ${report.torch.device}, face models on ${report.ort.provider}.`);
  return 0;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
