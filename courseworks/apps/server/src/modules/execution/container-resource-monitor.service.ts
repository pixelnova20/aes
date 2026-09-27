/**
 * 监控 Courseworks 自己创建的容器并处理资源失控。
 * 监控器只查询带 `courseworks.managed=true` label 的容器，绝不按名称或全局进程表操作其他项目。
 */
import { spawn } from "node:child_process";

import { config } from "../../config/index.js";
import { DISK_QUOTA_ERROR_MESSAGE, getWorkspaceDiskQuota } from "../workspaces/index.js";
import type { ContainerRunProfile } from "./container-run-profile.js";

export type ResourceLimitReason = "cpu_hog" | "memory_hog" | "pid_hog" | "output_flood" | "idle_timeout" | "max_lifetime" | "disk_quota";

type ManagedContainer = {
  containerName: string;
  profile: ContainerRunProfile;
  startedAt: number;
  lastActivityAt: number;
  lastProgressAt: number;
  outputWindowStartedAt: number;
  outputWindowBytes: number;
  highCpuSince: number | null;
  highMemoryOrPidSince: number | null;
  metadata: Record<string, string | undefined>;
  onLimit: (reason: ResourceLimitReason) => void;
};

type DockerStats = { Name?: string; CPUPerc?: string; MemUsage?: string; PIDs?: string };

const managed = new Map<string, ManagedContainer>();
let monitorTimer: NodeJS.Timeout | null = null;
let statsInFlight = false;

function numberFromPercent(value: string | undefined) {
  const parsed = Number.parseFloat((value ?? "").replace("%", ""));
  return Number.isFinite(parsed) ? parsed / 100 : 0;
}

function memoryUsage(value: string | undefined) {
  const usage = (value ?? "").split("/")[0]?.trim() ?? "";
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/i.exec(usage);
  if (!match) return 0;
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = unit === "kb" ? 1000 : unit === "kib" ? 1024 : unit === "mb" ? 1000 ** 2 : unit === "mib" ? 1024 ** 2 : unit === "gb" ? 1000 ** 3 : unit === "gib" ? 1024 ** 3 : unit === "tb" ? 1000 ** 4 : unit === "tib" ? 1024 ** 4 : 1;
  return Number(match[1]) * multiplier;
}

function readStats() {
  return new Promise<DockerStats[]>((resolve) => {
    const child = spawn("docker", ["stats", "--no-stream", "--format", "{{json .}}", "--filter", "label=courseworks.managed=true"], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.on("error", () => resolve([]));
    child.on("close", () => {
      resolve(output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line) as DockerStats]; } catch { return []; }
      }));
    });
  });
}

function terminate(container: ManagedContainer, reason: ResourceLimitReason) {
  container.onLimit(reason);
  const child = spawn("docker", ["rm", "-f", container.containerName], { shell: false, stdio: "ignore" });
  child.on("error", () => undefined);
}

async function sample() {
  if (statsInFlight || managed.size === 0) return;
  statsInFlight = true;
  try {
    const stats = await readStats();
    const byName = new Map(stats.map((item) => [item.Name, item]));
    const now = Date.now();
    const quotaChecks = new Map<string, ReturnType<typeof getWorkspaceDiskQuota>>();
    for (const [name, container] of managed) {
      const item = byName.get(name);
      if (!item) continue;
      const cpuRatio = numberFromPercent(item.CPUPerc) / container.profile.cpus;
      const memoryRatio = memoryUsage(item.MemUsage) / container.profile.memoryBytes;
      const pidRatio = Number.parseFloat(item.PIDs ?? "0") / container.profile.pidsLimit;
      const isInteractive = container.profile.purpose === "shell" || container.profile.purpose === "qemu";

      const workspacePath = container.metadata.workspacePath;
      if (workspacePath) {
        const quotaPromise = quotaChecks.get(workspacePath) ?? getWorkspaceDiskQuota(workspacePath);
        quotaChecks.set(workspacePath, quotaPromise);
        const quota = await quotaPromise.catch(() => null);
        if (quota?.hardExceeded) {
          terminate(container, "disk_quota");
          continue;
        }
      }

      if (cpuRatio >= config.EXECUTION_CPU_HOG_THRESHOLD && container.profile.purpose !== "qemu" && now - container.lastProgressAt >= config.EXECUTION_CPU_HOG_DURATION_MS) {
        container.highCpuSince ??= container.lastProgressAt;
        if (now - container.highCpuSince >= config.EXECUTION_CPU_HOG_DURATION_MS) return terminate(container, "cpu_hog");
      } else {
        container.highCpuSince = null;
      }

      if (memoryRatio >= config.EXECUTION_MEMORY_HOG_THRESHOLD || pidRatio >= config.EXECUTION_PID_HOG_THRESHOLD) {
        container.highMemoryOrPidSince ??= now;
        if (now - container.highMemoryOrPidSince >= config.EXECUTION_MEMORY_PID_DURATION_MS) {
          return terminate(container, memoryRatio >= config.EXECUTION_MEMORY_HOG_THRESHOLD ? "memory_hog" : "pid_hog");
        }
      } else {
        container.highMemoryOrPidSince = null;
      }

      const outputWindowMs = now - container.outputWindowStartedAt;
      if (container.outputWindowBytes >= config.EXECUTION_OUTPUT_RATE_BYTES_PER_SEC * (config.EXECUTION_OUTPUT_RATE_DURATION_MS / 1000) && outputWindowMs >= config.EXECUTION_OUTPUT_RATE_DURATION_MS) {
        return terminate(container, "output_flood");
      }
      if (outputWindowMs >= config.EXECUTION_OUTPUT_RATE_DURATION_MS) {
        container.outputWindowStartedAt = now;
        container.outputWindowBytes = 0;
      }

      if (isInteractive && now - container.startedAt >= config.EXECUTION_SESSION_MAX_LIFETIME_MS) return terminate(container, "max_lifetime");
      if (container.profile.purpose === "shell" && now - container.lastActivityAt >= config.EXECUTION_SHELL_IDLE_TIMEOUT_MS) return terminate(container, "idle_timeout");
    }
  } finally {
    statsInFlight = false;
  }
}

export function startContainerResourceMonitor() {
  if (monitorTimer) return;
  monitorTimer = setInterval(() => { void sample(); }, config.EXECUTION_MONITOR_INTERVAL_MS);
  monitorTimer.unref();
}

export function stopContainerResourceMonitor() {
  if (!monitorTimer) return;
  clearInterval(monitorTimer);
  monitorTimer = null;
}

export function registerManagedContainer(args: {
  containerName: string;
  profile: ContainerRunProfile;
  metadata?: Record<string, string | undefined>;
  onLimit: (reason: ResourceLimitReason) => void;
}) {
  const now = Date.now();
  managed.set(args.containerName, {
    containerName: args.containerName,
    profile: args.profile,
    startedAt: now,
    lastActivityAt: now,
    lastProgressAt: now,
    outputWindowStartedAt: now,
    outputWindowBytes: 0,
    highCpuSince: null,
    highMemoryOrPidSince: null,
    metadata: args.metadata ?? {},
    onLimit: (reason) => {
      if (!managed.has(args.containerName)) return;
      args.onLimit(reason);
      managed.delete(args.containerName);
    },
  });
  startContainerResourceMonitor();
}

export function noteContainerActivity(containerName: string) {
  const item = managed.get(containerName);
  if (item) item.lastActivityAt = Date.now();
}

export function noteContainerProgress(containerName: string) {
  const item = managed.get(containerName);
  if (item) {
    item.lastActivityAt = Date.now();
    item.lastProgressAt = item.lastActivityAt;
  }
}

export function noteContainerOutput(containerName: string, bytes: number) {
  const item = managed.get(containerName);
  if (!item) return;
  item.outputWindowBytes += bytes;
  noteContainerProgress(containerName);
}

export function unregisterManagedContainer(containerName: string) {
  managed.delete(containerName);
}

export function resourceLimitMessage(reason: ResourceLimitReason) {
  return reason === "disk_quota" ? DISK_QUOTA_ERROR_MESSAGE : `Resource limit exceeded: ${reason}`;
}

export const containerResourceMonitorTestSupport = {
  numberFromPercent,
  memoryUsage,
  reset() { managed.clear(); stopContainerResourceMonitor(); },
  size() { return managed.size; },
};
