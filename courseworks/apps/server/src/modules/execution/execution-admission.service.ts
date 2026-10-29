/**
 * Courseworks 的进程级资源准入器。
 * 它只统计本后端创建的受管容器，不改变 Docker 对其他项目的行为。
 */
import { randomUUID } from "node:crypto";

import { config } from "../../config/index.js";
import type { ContainerRunProfile } from "./container-run-profile.js";
import { resourceEvent } from "./resource-telemetry.js";

export type ExecutionAdmissionRequest = {
  profiles: ContainerRunProfile[];
  workspaceId?: string;
  interactive?: boolean;
  signal?: AbortSignal;
};

export type ExecutionAdmissionLease = {
  id: string;
  request: ExecutionAdmissionRequest;
  release: () => void;
};

type Reservation = {
  lease: ExecutionAdmissionLease;
  workspaceId?: string;
  cpu: number;
  memoryBytes: number;
  qemu: number;
  heavy: number;
};

type WaitingRequest = {
  request: ExecutionAdmissionRequest;
  resolve: (lease: ExecutionAdmissionLease) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
  enqueuedAt: number;
};

const reservations = new Map<string, Reservation>();
const waiting: WaitingRequest[] = [];

function totals() {
  const result = [...reservations.values()].reduce((current, reservation) => {
    if (reservation.workspaceId) {
      if (reservation.heavy > 0) current.heavyByWorkspace.set(reservation.workspaceId, (current.heavyByWorkspace.get(reservation.workspaceId) ?? 0) + reservation.heavy);
      if (reservation.lease.request.profiles.some((item) => item.purpose === "shell")) current.shellByWorkspace.set(reservation.workspaceId, (current.shellByWorkspace.get(reservation.workspaceId) ?? 0) + 1);
    }
    return {
      cpu: current.cpu + reservation.cpu,
      memoryBytes: current.memoryBytes + reservation.memoryBytes,
      qemu: current.qemu + reservation.qemu,
      heavyByWorkspace: current.heavyByWorkspace,
      shellByWorkspace: current.shellByWorkspace,
    };
  }, {
    cpu: 0,
    memoryBytes: 0,
    qemu: 0,
    heavyByWorkspace: new Map<string, number>(),
    shellByWorkspace: new Map<string, number>(),
  });
  return result;
}

function canAcquire(request: ExecutionAdmissionRequest) {
  const requestedCpu = request.profiles.reduce((sum, item) => sum + item.cpus, 0);
  const requestedMemory = request.profiles.reduce((sum, item) => sum + item.memoryBytes, 0);
  const requestedQemu = request.profiles.filter((item) => item.qemu).length;
  const requestedHeavy = request.profiles.filter((item) => item.heavy).length;
  const current = totals();
  if (current.cpu + requestedCpu > config.EXECUTION_GLOBAL_CPU_BUDGET) return false;
  if (current.memoryBytes + requestedMemory > parseMemoryBudget()) return false;
  if (current.qemu + requestedQemu > config.EXECUTION_MAX_QEMU) return false;
  if (request.workspaceId) {
    const currentHeavy = current.heavyByWorkspace.get(request.workspaceId) ?? 0;
    const currentShell = current.shellByWorkspace.get(request.workspaceId) ?? 0;
    if (currentHeavy + requestedHeavy > config.EXECUTION_MAX_HEAVY_PER_WORKSPACE) return false;
    if (request.profiles.some((item) => item.purpose === "shell") && currentShell + 1 > config.EXECUTION_MAX_SHELL_PER_WORKSPACE) return false;
  }
  return true;
}

function parseMemoryBudget() {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb|t|tb)?\s*$/i.exec(config.EXECUTION_GLOBAL_MEMORY_BUDGET);
  if (!match) throw new Error(`Invalid EXECUTION_GLOBAL_MEMORY_BUDGET: ${config.EXECUTION_GLOBAL_MEMORY_BUDGET}`);
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = unit === "k" || unit === "kb" ? 1024 : unit === "m" || unit === "mb" ? 1024 ** 2 : unit === "g" || unit === "gb" ? 1024 ** 3 : unit === "t" || unit === "tb" ? 1024 ** 4 : 1;
  return Math.floor(Number(match[1]) * multiplier);
}

function createLease(request: ExecutionAdmissionRequest): ExecutionAdmissionLease {
  const startedAt = Date.now();
  const lease = { id: randomUUID(), request, release: () => undefined } as ExecutionAdmissionLease;
  const reservation: Reservation = {
    lease,
    workspaceId: request.workspaceId,
    cpu: request.profiles.reduce((sum, item) => sum + item.cpus, 0),
    memoryBytes: request.profiles.reduce((sum, item) => sum + item.memoryBytes, 0),
    qemu: request.profiles.filter((item) => item.qemu).length,
    heavy: request.profiles.filter((item) => item.heavy).length,
  };
  reservations.set(lease.id, reservation);
  resourceEvent("admission_acquired", { leaseId: lease.id, workspaceId: request.workspaceId, purposes: request.profiles.map((p) => p.purpose), cpu: reservation.cpu, memoryBytes: reservation.memoryBytes, admission: executionAdmissionSnapshot() });
  lease.release = () => {
    if (!reservations.delete(lease.id)) return;
    resourceEvent("admission_released", { leaseId: lease.id, workspaceId: request.workspaceId, durationMs: Date.now() - startedAt, admission: executionAdmissionSnapshot() });
    drainQueue();
  };
  return lease;
}

function drainQueue() {
  let index = 0;
  while (index < waiting.length) {
    const item = waiting[index];
    if (!canAcquire(item.request)) {
      index += 1;
      continue;
    }
    waiting.splice(index, 1);
    clearTimeout(item.timer);
    item.cleanup();
    resourceEvent("admission_dequeued", { workspaceId: item.request.workspaceId, waitedMs: Date.now() - item.enqueuedAt });
    item.resolve(createLease(item.request));
  }
}

/** 交互任务使用此同步接口，资源不足时立即返回 false。 */
export function tryAcquireExecutionAdmission(request: ExecutionAdmissionRequest) {
  if (request.signal?.aborted) return null;
  if (canAcquire(request)) return createLease(request);
  resourceEvent("admission_denied", { workspaceId: request.workspaceId, purposes: request.profiles.map((p) => p.purpose), requestedCpu: request.profiles.reduce((s, p) => s + p.cpus, 0), requestedMemoryBytes: request.profiles.reduce((s, p) => s + p.memoryBytes, 0), admission: executionAdmissionSnapshot() });
  return null;
}

/** 按入队顺序检查短任务，先放行当前预算可容纳的请求。 */
export function acquireExecutionAdmission(request: ExecutionAdmissionRequest) {
  if (request.signal?.aborted) return Promise.reject(new Error("aborted"));
  const immediate = tryAcquireExecutionAdmission(request);
  if (immediate) return Promise.resolve(immediate);
  if (request.interactive) return Promise.reject(new Error("Execution resources are temporarily busy; retry the interactive session."));
  return new Promise<ExecutionAdmissionLease>((resolve, reject) => {
    const item = {} as WaitingRequest;
    item.request = request;
    item.resolve = resolve;
    item.reject = reject;
    item.enqueuedAt = Date.now();
    const abort = () => {
      const index = waiting.indexOf(item);
      if (index < 0) return;
      waiting.splice(index, 1);
      clearTimeout(item.timer);
      item.cleanup();
      resourceEvent("admission_cancelled", { workspaceId: request.workspaceId, waitedMs: Date.now() - item.enqueuedAt });
      reject(new Error("aborted"));
    };
    item.cleanup = () => request.signal?.removeEventListener("abort", abort);
    item.timer = setTimeout(() => {
      const index = waiting.indexOf(item);
      if (index >= 0) waiting.splice(index, 1);
      item.cleanup();
      resourceEvent("admission_timeout", { workspaceId: request.workspaceId, waitedMs: Date.now() - item.enqueuedAt, admission: executionAdmissionSnapshot() });
      reject(new Error("Execution resources are temporarily busy; retry shortly."));
    }, config.EXECUTION_ADMISSION_QUEUE_TIMEOUT_MS);
    waiting.push(item);
    request.signal?.addEventListener("abort", abort, { once: true });
    resourceEvent("admission_queued", { workspaceId: request.workspaceId, waiting: waiting.length });
  });
}

export function executionAdmissionSnapshot() {
  const current = totals();
  return { active: reservations.size, waiting: waiting.length, reservedCpu: current.cpu, reservedMemoryBytes: current.memoryBytes, qemu: current.qemu, cpuBudget: config.EXECUTION_GLOBAL_CPU_BUDGET, memoryBudgetBytes: parseMemoryBudget() };
}

export const executionAdmissionTestSupport = {
  reset() {
    for (const item of waiting.splice(0)) {
      clearTimeout(item.timer);
      item.cleanup();
      item.reject(new Error("Admission test reset."));
    }
    reservations.clear();
  },
  snapshot() {
    const current = totals();
    return { active: reservations.size, cpu: current.cpu, memoryBytes: current.memoryBytes, qemu: current.qemu };
  },
};
