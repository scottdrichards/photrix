import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import os from "node:os";

const execAsync = promisify(exec);

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
  };
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

async function fetchGpuMetrics(): Promise<SystemMetrics["gpu"]> {
  if (!gpuAvailable) return undefined;
  try {
    const { stdout } = await execAsync(
      "nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits",
      { timeout: 2000 },
    );
    const lines = stdout.trim().split("\n");
    if (lines.length === 0) return undefined;
    const [gpuUsage, memoryUsed, memoryTotal] = lines[0]!
      .split(",")
      .map((s) => parseInt(s.trim(), 10));
    return {
      usage: gpuUsage ?? 0,
      memory:
        memoryUsed !== undefined && memoryTotal !== undefined
          ? { used: memoryUsed, total: memoryTotal }
          : undefined,
    };
  } catch {
    // nvidia-smi missing or failed. Stop trying until process restarts.
    gpuAvailable = false;
    return undefined;
  }
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
    writeLatencyMs: writesDelta > 0 ? Math.round(writeTimeDelta / writesDelta) : undefined,
    utilization: Math.min(100, Math.round((ioTimeDelta / timeDeltaMs) * 100)),
  };
}

async function computeSystemMetrics(): Promise<SystemMetrics> {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const [disk, gpu] = await Promise.all([calculateDiskMetrics(), getGpuMetrics()]);

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
