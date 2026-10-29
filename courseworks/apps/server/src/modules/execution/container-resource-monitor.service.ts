import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import fs from "node:fs/promises";

import { config } from "../../config/index.js";
import { DISK_QUOTA_ERROR_MESSAGE, getWorkspaceDiskQuota } from "../workspaces/index.js";
import type { ContainerRunProfile } from "./container-run-profile.js";
import { executionAdmissionSnapshot } from "./execution-admission.service.js";
import { resourceEvent, resourceIds } from "./resource-telemetry.js";

export type ResourceLimitReason = "cpu_hog" | "memory_hog" | "pid_hog" | "output_flood" | "idle_timeout" | "max_lifetime" | "disk_quota" | "container_missing";
type ManagedContainer = {
  containerName: string;
  profile: ContainerRunProfile;
  startedAt: number;
  lastActivityAt: number;
  outputWindowStartedAt: number;
  outputWindowBytes: number;
  metadata: Record<string, string | undefined>;
  onLimit: (reason: ResourceLimitReason) => void;
  samples: number;
  peakMemoryBytes: number;
  peakCpuCores: number;
  missing: number;
};
type DockerStats = { Name?: string; CPUPerc?: string; MemUsage?: string; PIDs?: string; BlockIO?: string; NetIO?: string };
const managed = new Map<string, ManagedContainer>();
export function managedContainerSnapshot() {
  return [...managed.values()].map(c => ({ workspaceId: c.metadata.workspaceId,
    purpose: c.profile.purpose, startedAt: new Date(c.startedAt).toISOString(),
    cpuLimit: c.profile.cpus, memoryLimitBytes: c.profile.memoryBytes }));
}
const orphans = new Map<string, number>();
let monitorTimer: NodeJS.Timeout | null = null;
let statsInFlight = false;
let lastSummaryAt = 0;
const exec = promisify(execFile);
const realDocker = async (args: string[]) => (await exec("docker", args, { timeout: 10000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024 })).stdout;
let docker = realDocker;

function numberFromPercent(value: string | undefined) {
  const parsed = Number.parseFloat((value ?? "").replace("%", ""));
  return Number.isFinite(parsed) ? parsed / 100 : 0;
}
function memoryUsage(value: string | undefined) {
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib|tb|tib)?$/i.exec((value ?? "").split("/")[0]?.trim() ?? "");
  if (!match) return 0;
  const unit = (match[2] ?? "b").toLowerCase();
  const power = { b: 0, kb: 1, kib: 1, mb: 2, mib: 2, gb: 3, gib: 3, tb: 4, tib: 4 }[unit] ?? 0;
  return Number(match[1]) * (unit.includes("i") ? 1024 : 1000) ** power;
}
function identity(container: ManagedContainer) {
  return { containerName: container.containerName, purpose: container.profile.purpose, ...resourceIds(container.metadata) };
}
function failure(operation: string, error: unknown) {
  const err = error as { code?: string | number; killed?: boolean };
  resourceEvent("monitor_error", { operation, code: err?.code ?? "UNKNOWN", killed: err?.killed ?? false });
}
function terminate(container: ManagedContainer, reason: ResourceLimitReason) {
  if (!managed.has(container.containerName)) return;
  resourceEvent("container_terminated", { ...identity(container), reason, durationMs: Date.now() - container.startedAt });
  unregisterManagedContainer(container.containerName);
  orphans.set(container.containerName, Date.now() - 60000);
  try { container.onLimit(reason); } catch (error) { failure("onLimit", error); }
  void docker(["rm", "-f", container.containerName]).catch((error) => failure("remove", error));
}

// Time limits still run when Docker stats hangs or returns no samples.
function enforceDeadlines(now = Date.now()) {
  for (const container of managed.values()) {
    const purpose = container.profile.purpose;
    if ((purpose === "shell" || purpose === "qemu") && now - container.startedAt >= config.EXECUTION_SESSION_MAX_LIFETIME_MS) {
      terminate(container, "max_lifetime");
    } else if (purpose === "shell" && now - container.lastActivityAt >= config.EXECUTION_SHELL_IDLE_TIMEOUT_MS) {
      terminate(container, "idle_timeout");
    }
  }
}

async function hostSample() {
  const meminfo = await fs.readFile("/proc/meminfo", "utf8").catch(() => "");
  const mem = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(meminfo)?.[1] ?? 0) * 1024;
  const pressure: Record<string, string> = {};
  for (const kind of ["cpu", "memory", "io"]) {
    pressure[kind] = await fs.readFile(`/proc/pressure/${kind}`, "utf8").then((s) => s.trim()).catch(() => "unavailable");
  }
  resourceEvent("host_sample", { totalMemoryBytes: os.totalmem(), availableMemoryBytes: mem("MemAvailable"), swapUsedBytes: mem("SwapTotal") - mem("SwapFree"), loadAverage: os.loadavg(), backendRssBytes: process.memoryUsage().rss, pressure, admission: executionAdmissionSnapshot(), managedContainers: managed.size });
}

async function sample() {
  if (statsInFlight) return;
  statsInFlight = true;
  try {
    const emitSamples = Date.now() - lastSummaryAt >= 15000;
    if (emitSamples) { lastSummaryAt = Date.now(); await hostSample(); }
    // Filtering is supported by docker ps, NOT docker stats. Never run stats without IDs.
    const names = (await docker(["ps", "-a", "--filter", "label=courseworks.managed=true", "--format", "{{.Names}}"])).split(/\r?\n/).filter(Boolean);
    const existing = new Set(names);
    for (const name of orphans.keys()) if (!existing.has(name)) orphans.delete(name);
    for (const name of names) {
      if (managed.has(name)) { orphans.delete(name); continue; }
      const firstSeen = orphans.get(name) ?? Date.now();
      orphans.set(name, firstSeen);
      if (Date.now() - firstSeen >= 60000) {
        try {
          await docker(["rm", "-f", name]);
          orphans.delete(name);
          resourceEvent("orphan_removed", { containerName: name });
        } catch (error) { failure("orphan_remove", error); }
      }
    }
    for (const container of managed.values()) {
      container.missing = existing.has(container.containerName) ? 0 : container.missing + 1;
      if (container.missing >= 3 && Date.now() - container.startedAt > 30000) terminate(container, "container_missing");
    }
    const selected = names.filter((name) => managed.has(name));
    const stats = selected.length ? (await docker(["stats", "--no-stream", "--format", "{{json .}}", ...selected])).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as DockerStats) : [];
    const quotaChecks = new Map<string, ReturnType<typeof getWorkspaceDiskQuota>>();
    for (const item of stats) {
      const container = managed.get(item.Name ?? "");
      if (!container) continue;
      const cpuCores = numberFromPercent(item.CPUPerc);
      const memoryBytes = memoryUsage(item.MemUsage);
      const pids = Number.parseInt(item.PIDs ?? "0", 10) || 0;
      container.samples += 1;
      container.peakMemoryBytes = Math.max(container.peakMemoryBytes, memoryBytes);
      container.peakCpuCores = Math.max(container.peakCpuCores, cpuCores);
      if (emitSamples) resourceEvent("container_sample", { ...identity(container), cpuCores, memoryBytes, pids, cpuLimit: container.profile.cpus, memoryLimitBytes: container.profile.memoryBytes, pidLimit: container.profile.pidsLimit, blockIO: item.BlockIO, netIO: item.NetIO, ageMs: Date.now() - container.startedAt, inactiveMs: Date.now() - container.lastActivityAt });
      // Busy computation is valid. Cgroups enforce CPU/memory/PID ceilings.
      // Deadlines and output/disk controls bound quiet compilers and runaway tasks.
      const workspacePath = container.metadata.workspacePath;
      if (workspacePath) {
        const check = quotaChecks.get(workspacePath) ?? getWorkspaceDiskQuota(workspacePath);
        quotaChecks.set(workspacePath, check);
        const quota = await check.catch((error) => { failure("disk_quota", error); return null; });
        if (quota?.hardExceeded) terminate(container, "disk_quota");
      }
    }
  } catch (error) { failure("sample", error); }
  finally { statsInFlight = false; }
}

export function startContainerResourceMonitor() {
  if (monitorTimer) return;
  resourceEvent("monitor_started", { intervalMs: config.EXECUTION_MONITOR_INTERVAL_MS, sampleLogIntervalMs: 15000, idleTimeoutMs: config.EXECUTION_SHELL_IDLE_TIMEOUT_MS, maxLifetimeMs: config.EXECUTION_SESSION_MAX_LIFETIME_MS });
  monitorTimer = setInterval(() => { enforceDeadlines(); void sample(); }, config.EXECUTION_MONITOR_INTERVAL_MS);
  monitorTimer.unref();
}
export function stopContainerResourceMonitor() {
  if (monitorTimer) clearInterval(monitorTimer);
  monitorTimer = null;
}
export function registerManagedContainer(args: { containerName: string; profile: ContainerRunProfile; metadata?: Record<string, string | undefined>; onLimit: (reason: ResourceLimitReason) => void }) {
  const now = Date.now();
  const container: ManagedContainer = { ...args, startedAt: now, lastActivityAt: now, outputWindowStartedAt: now, outputWindowBytes: 0, metadata: args.metadata ?? {}, samples: 0, peakMemoryBytes: 0, peakCpuCores: 0, missing: 0 };
  managed.set(args.containerName, container);
  resourceEvent("container_registered", { ...identity(container), cpuLimit: args.profile.cpus, memoryLimitBytes: args.profile.memoryBytes, pidLimit: args.profile.pidsLimit });
  startContainerResourceMonitor();
}
export function noteContainerActivity(containerName: string) {
  const item = managed.get(containerName);
  if (item) item.lastActivityAt = Date.now();
}
export function noteContainerProgress(containerName: string) { noteContainerActivity(containerName); }
export function noteContainerOutput(containerName: string, bytes: number) {
  const item = managed.get(containerName);
  if (!item) return;
  const now = Date.now();
  if (now - item.outputWindowStartedAt >= config.EXECUTION_OUTPUT_RATE_DURATION_MS) {
    item.outputWindowStartedAt = now;
    item.outputWindowBytes = 0;
  }
  item.outputWindowBytes += bytes;
  if (item.outputWindowBytes > config.EXECUTION_OUTPUT_RATE_BYTES_PER_SEC * config.EXECUTION_OUTPUT_RATE_DURATION_MS / 1000) terminate(item, "output_flood");
  else noteContainerActivity(containerName);
}
export function unregisterManagedContainer(containerName: string) {
  const item = managed.get(containerName);
  if (!item) return;
  resourceEvent("container_finished", { ...identity(item), durationMs: Date.now() - item.startedAt, samples: item.samples, sampledPeakMemoryBytes: item.peakMemoryBytes, sampledPeakCpuCores: item.peakCpuCores });
  managed.delete(containerName);
}
export function resourceLimitMessage(reason: ResourceLimitReason) { return reason === "disk_quota" ? DISK_QUOTA_ERROR_MESSAGE : `Resource limit exceeded: ${reason}`; }
export const containerResourceMonitorTestSupport = {
  numberFromPercent, memoryUsage, sample, enforceDeadlines,
  setDocker(fn: typeof realDocker) { docker = fn; },
  reset() { managed.clear(); orphans.clear(); stopContainerResourceMonitor(); docker = realDocker; lastSummaryAt = 0; },
  size() { return managed.size; },
};
