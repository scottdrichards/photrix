import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import os from "node:os";
import {
  getComputeWorkerPids,
  type ComputeWorkerRole,
} from "../taskOrchestrator/computeWorkers.ts";

const execAsync = promisify(exec);

// Standard page size on x86_64 Linux; /proc/<pid>/statm reports resident memory
// in pages. Used to turn resident pages into MB for the per-worker RAM readout.
const PAGE_SIZE_BYTES = 4096;

export type ComputeProcessRole = ComputeWorkerRole | "other";

export type GpuProcess = {
  pid: number;
  role: ComputeProcessRole;
  vramMB: number;
};

export type ComputeWorkerMetric = {
  id: string;
  role: ComputeProcessRole;
  pid: number;
  vramMB: number; // 0 when the worker holds no VRAM (e.g. running on CPU)
  rssMB: number;
  suspended: boolean;
  leases: number;
};

export type SystemMetrics = {
  cpu: {
    usage: number; // percentage 0-100
    cores: number;
  };
  memory: {
    used: number; // bytes
    total: number; // bytes
    usage: number; // percentage 0-100
  };
  disk?: {
    readLatencyMs?: number;
    writeLatencyMs?: number;
    utilization?: number; // percentage 0-100
    iopsRead?: number;
    iopsWrite?: number;
  };
  gpu?: {
    usage: number; // percentage 0-100
    memory?: {
      used: number; // MB
      total: number; // MB
    };
    // Per-process VRAM breakdown from nvidia-smi, role-tagged against the
    // registered ML workers. Absent when nvidia-smi is unavailable.
    processes?: GpuProcess[];
    // VRAM in use on the card but not attributable to any pid nvidia-smi can
    // resolve here. Inside a container that shares the GPU (LXC passthrough),
    // processes on the host or in sibling containers hold VRAM invisibly; this
    // makes that external usage observable instead of silently shrinking the
    // budget until transcodes lose NVENC. A small residue (~100–300 MB of
    // driver/context overhead) is normal.
    unaccountedMB?: number;
  };
  // Every registered ML worker with a live pid, combining nvidia-smi VRAM,
  // /proc RSS, and the orchestrator's freeze/lease state. Lets the status UI
  // show who is holding VRAM and whether they've been reclaimed for a user
  // request.
  workers?: ComputeWorkerMetric[];
};

let lastCpuMeasure = getCpuMeasure();

type DiskStats = {
  readsCompleted: number;
  writesCompleted: number;
  readTimeMs: number;
  writeTimeMs: number;
  ioTimeMs: number;
  timestamp: number;
};

let lastDiskStats: DiskStats | undefined;

function getCpuMeasure() {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;

  cpus.forEach((cpu) => {
    for (const type of Object.keys(cpu.times) as Array<keyof typeof cpu.times>) {
      totalTick += cpu.times[type];
    }
    totalIdle += cpu.times.idle;
  });

  return { totalIdle, totalTick };
}

function calculateCpuUsage(): number {
  const currentMeasure = getCpuMeasure();
  const diffIdle = currentMeasure.totalIdle - lastCpuMeasure.totalIdle;
  const diffTick = currentMeasure.totalTick - lastCpuMeasure.totalTick;
  const usage = 100 - ~~((100 * diffIdle) / diffTick);
  lastCpuMeasure = currentMeasure;
  return Math.max(0, Math.min(100, usage));
}

const GPU_CACHE_TTL_MS = 2000;
let gpuCache: { value: SystemMetrics["gpu"]; expiresAt: number } | undefined;
let gpuInflight: Promise<SystemMetrics["gpu"]> | undefined;
let gpuAvailable = true;

// Raw per-pid VRAM from nvidia-smi, before role tagging. Keyed by pid.
async function fetchGpuProcessVram(): Promise<Map<number, number>> {
  const byPid = new Map<number, number>();
  try {
    const { stdout } = await execAsync(
      "nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits",
      { timeout: 2000 },
    );
    for (const line of stdout.trim().split("\n")) {
      if (!line.trim()) continue;
      const [pid, usedMemory] = line.split(",").map((s) => parseInt(s.trim(), 10));
      if (pid !== undefined && !Number.isNaN(pid) && usedMemory !== undefined) {
        byPid.set(pid, usedMemory);
      }
    }
  } catch {
    // Older nvidia-smi builds or a transient failure: fall back to no breakdown.
  }
  return byPid;
}

/**
 * Fresh (uncached) free-VRAM reading in MB, for the reclaim guard that must poll
 * VRAM as it is released. Returns undefined when nvidia-smi is unavailable.
 */
export async function queryGpuFreeMB(): Promise<number | undefined> {
  if (!gpuAvailable) return undefined;
  try {
    const { stdout } = await execAsync(
      "nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits",
      { timeout: 2000 },
    );
    const free = parseInt(stdout.trim().split("\n")[0].trim(), 10);
    return Number.isFinite(free) ? free : undefined;
  } catch {
    return undefined;
  }
}

async function fetchGpuMetrics(): Promise<SystemMetrics["gpu"]> {
  if (!gpuAvailable) return undefined;
  try {
    const [{ stdout }, processVram] = await Promise.all([
      execAsync(
        "nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits",
        { timeout: 2000 },
      ),
      fetchGpuProcessVram(),
    ]);
    const lines = stdout.trim().split("\n");
    if (lines.length === 0) return undefined;
    const [gpuUsage, memoryUsed, memoryTotal] = lines[0]
      .split(",")
      .map((s) => parseInt(s.trim(), 10));

    // Role-tag each compute process against the registered ML workers; anything
    // else on the GPU (e.g. an ffmpeg NVENC transcode) is "other".
    const roleByPid = new Map<number, ComputeProcessRole>();
    for (const worker of getComputeWorkerPids()) {
      roleByPid.set(worker.pid, worker.role ?? "other");
    }
    const processes: GpuProcess[] = [...processVram.entries()].map(([pid, vramMB]) => ({
      pid,
      role: roleByPid.get(pid) ?? "other",
      vramMB,
    }));

    const accountedMB = processes.reduce((sum, p) => sum + p.vramMB, 0);

    return {
      usage: gpuUsage ?? 0,
      memory:
        memoryUsed !== undefined && memoryTotal !== undefined
          ? { used: memoryUsed, total: memoryTotal }
          : undefined,
      processes,
      unaccountedMB:
        memoryUsed !== undefined ? Math.max(0, memoryUsed - accountedMB) : undefined,
    };
  } catch {
    // nvidia-smi missing or failed. Stop trying until process restarts.
    gpuAvailable = false;
    return undefined;
  }
}

// Resident set size (RAM) of a pid in MB, read from /proc without spawning a
// process. Returns 0 if the pid is gone or /proc is unavailable (e.g. non-Linux).
async function readRssMB(pid: number): Promise<number> {
  try {
    const statm = await readFile(`/proc/${pid}/statm`, "utf-8");
    const residentPages = parseInt(statm.trim().split(/\s+/)[1] ?? "0", 10);
    if (!Number.isFinite(residentPages)) return 0;
    return Math.round((residentPages * PAGE_SIZE_BYTES) / (1024 * 1024));
  } catch {
    return 0;
  }
}

// Combine the registered worker set (pid + freeze/lease state) with nvidia-smi
// VRAM and /proc RSS into a single per-worker view for the status UI.
async function collectComputeWorkers(
  gpu: SystemMetrics["gpu"],
): Promise<ComputeWorkerMetric[]> {
  const vramByPid = new Map<number, number>();
  for (const proc of gpu?.processes ?? []) vramByPid.set(proc.pid, proc.vramMB);

  const registered = getComputeWorkerPids();
  return Promise.all(
    registered.map(async (worker) => ({
      id: worker.id,
      role: worker.role ?? "other",
      pid: worker.pid,
      vramMB: vramByPid.get(worker.pid) ?? 0,
      rssMB: await readRssMB(worker.pid),
      suspended: worker.suspended,
      leases: worker.leases,
    })),
  );
}

async function getGpuMetrics(): Promise<SystemMetrics["gpu"]> {
  const now = Date.now();
  if (gpuCache && gpuCache.expiresAt > now) return gpuCache.value;
  if (gpuInflight) return gpuInflight;

  gpuInflight = fetchGpuMetrics()
    .then((value) => {
      gpuCache = { value, expiresAt: Date.now() + GPU_CACHE_TTL_MS };
      return value;
    })
    .finally(() => {
      gpuInflight = undefined;
    });

  return gpuInflight;
}

async function parseDiskStats(): Promise<DiskStats | undefined> {
  try {
    const content = await readFile("/proc/diskstats", "utf-8");
    let totalReads = 0;
    let totalWrites = 0;
    let totalReadTime = 0;
    let totalWriteTime = 0;
    let totalIoTime = 0;

    const lines = content.trim().split("\n");
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      const deviceName = fields[2];

      if (!deviceName || /\d$/.test(deviceName) || deviceName.startsWith("loop")) {
        continue;
      }

      totalReads += parseInt(fields[3] || "0", 10);
      totalWrites += parseInt(fields[7] || "0", 10);
      totalReadTime += parseInt(fields[6] || "0", 10);
      totalWriteTime += parseInt(fields[10] || "0", 10);
      totalIoTime += parseInt(fields[12] || "0", 10);
    }

    return {
      readsCompleted: totalReads,
      writesCompleted: totalWrites,
      readTimeMs: totalReadTime,
      writeTimeMs: totalWriteTime,
      ioTimeMs: totalIoTime,
      timestamp: Date.now(),
    };
  } catch {
    return undefined;
  }
}

async function calculateDiskMetrics(): Promise<SystemMetrics["disk"]> {
  const currentStats = await parseDiskStats();
  if (!currentStats) return undefined;

  if (!lastDiskStats) {
    lastDiskStats = currentStats;
    return undefined;
  }

  const timeDeltaMs = currentStats.timestamp - lastDiskStats.timestamp;
  if (timeDeltaMs <= 0) return undefined;

  const timeDeltaSec = timeDeltaMs / 1000;

  const readsDelta = currentStats.readsCompleted - lastDiskStats.readsCompleted;
  const writesDelta = currentStats.writesCompleted - lastDiskStats.writesCompleted;
  const readTimeDelta = currentStats.readTimeMs - lastDiskStats.readTimeMs;
  const writeTimeDelta = currentStats.writeTimeMs - lastDiskStats.writeTimeMs;
  const ioTimeDelta = currentStats.ioTimeMs - lastDiskStats.ioTimeMs;

  lastDiskStats = currentStats;

  return {
    iopsRead: Math.round(readsDelta / timeDeltaSec),
    iopsWrite: Math.round(writesDelta / timeDeltaSec),
    readLatencyMs: readsDelta > 0 ? Math.round(readTimeDelta / readsDelta) : undefined,
    writeLatencyMs:
      writesDelta > 0 ? Math.round(writeTimeDelta / writesDelta) : undefined,
    utilization: Math.min(100, Math.round((ioTimeDelta / timeDeltaMs) * 100)),
  };
}

async function computeSystemMetrics(): Promise<SystemMetrics> {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const [disk, gpu] = await Promise.all([calculateDiskMetrics(), getGpuMetrics()]);
  const workers = await collectComputeWorkers(gpu);

  return {
    cpu: {
      usage: calculateCpuUsage(),
      cores: cpus.length,
    },
    memory: {
      used: usedMem,
      total: totalMem,
      usage: Math.round((usedMem / totalMem) * 100),
    },
    disk,
    gpu,
    workers,
  };
}

// CPU and disk usage are computed from deltas against module-global state
// (`lastCpuMeasure`, `lastDiskStats`). If several callers (e.g. multiple SSE
// status clients) sampled concurrently they would each reset that window and
// corrupt every reading. A short shared cache makes the sampling cadence
// independent of caller count and keeps the deltas meaningful.
const METRICS_CACHE_TTL_MS = 1000;
let metricsCache: { value: SystemMetrics; expiresAt: number } | undefined;
let metricsInflight: Promise<SystemMetrics> | undefined;

export async function getSystemMetrics(): Promise<SystemMetrics> {
  const now = Date.now();
  if (metricsCache && metricsCache.expiresAt > now) return metricsCache.value;
  if (metricsInflight) return metricsInflight;

  metricsInflight = computeSystemMetrics()
    .then((value) => {
      metricsCache = { value, expiresAt: Date.now() + METRICS_CACHE_TTL_MS };
      return value;
    })
    .finally(() => {
      metricsInflight = undefined;
    });

  return metricsInflight;
}
