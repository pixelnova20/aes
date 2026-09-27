/**
 * 统一定义 Courseworks 管理的 Docker 容器资源档位、标签和安全参数。
 * 所有通过后端启动的容器都应使用本文件生成资源参数，避免不同执行入口出现不一致的限制。
 */
import { config } from "../../config/index.js";

export type ContainerPurpose =
  | "agent-bash"
  | "build"
  | "shell"
  | "qemu"
  | "runtime-sidecar"
  | "provider";

export type ContainerRunMetadata = {
  purpose: ContainerPurpose;
  userId?: string;
  workspaceId?: string;
  runId?: string;
  sessionId?: string;
};

export type ContainerRunProfile = {
  purpose: ContainerPurpose;
  cpus: number;
  memory: string;
  memoryBytes: number;
  pidsLimit: number;
  heavy: boolean;
  qemu: boolean;
};

/** 将 Docker 支持的常见内存写法转换为字节，供准入和监控使用。 */
export function parseMemoryBytes(value: string) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb|t|tb)?\s*$/i.exec(value);
  if (!match) throw new Error(`Invalid Docker memory value: ${value}`);
  const unit = (match[2] ?? "b").toLowerCase();
  const multiplier = unit === "k" || unit === "kb"
    ? 1024
    : unit === "m" || unit === "mb"
      ? 1024 ** 2
      : unit === "g" || unit === "gb"
        ? 1024 ** 3
        : unit === "t" || unit === "tb"
          ? 1024 ** 4
          : 1;
  return Math.floor(Number(match[1]) * multiplier);
}

function profile(purpose: ContainerPurpose, cpus: number, memory: string, pidsLimit: number, heavy: boolean, qemu = false): ContainerRunProfile {
  return { purpose, cpus, memory, memoryBytes: parseMemoryBytes(memory), pidsLimit, heavy, qemu };
}

export function getContainerRunProfile(purpose: ContainerPurpose): ContainerRunProfile {
  switch (purpose) {
    case "agent-bash":
      return profile(purpose, config.DOCKER_AGENT_CPUS, config.DOCKER_AGENT_MEMORY, config.DOCKER_AGENT_PIDS_LIMIT, true);
    case "build":
      return profile(purpose, config.DOCKER_RUNNER_CPUS, config.DOCKER_RUNNER_MEMORY, config.DOCKER_RUNNER_PIDS_LIMIT, true);
    case "shell":
      return profile(purpose, config.DOCKER_SHELL_CPUS, config.DOCKER_SHELL_MEMORY, config.DOCKER_SHELL_PIDS_LIMIT, false);
    case "qemu":
      return profile(purpose, config.DOCKER_QEMU_CPUS, config.DOCKER_QEMU_MEMORY, config.DOCKER_QEMU_PIDS_LIMIT, true, true);
    case "runtime-sidecar":
      return profile(purpose, config.DOCKER_RUNTIME_CPUS, config.DOCKER_RUNTIME_MEMORY, config.DOCKER_RUNTIME_PIDS_LIMIT, false);
    case "provider":
      return profile(purpose, config.DOCKER_PROVIDER_CPUS, config.DOCKER_PROVIDER_MEMORY, config.DOCKER_PROVIDER_PIDS_LIMIT, false);
  }
}

function labelValue(value: string | undefined) {
  return value?.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}

/** 生成仅包含 Courseworks 标识和可选关联 ID 的 Docker labels。 */
export function managedContainerLabelArgs(metadata: ContainerRunMetadata) {
  const labels = [
    ["courseworks.managed", "true"],
    ["courseworks.purpose", metadata.purpose],
    ["courseworks.user", labelValue(metadata.userId)],
    ["courseworks.workspace", labelValue(metadata.workspaceId)],
    ["courseworks.run", labelValue(metadata.runId)],
    ["courseworks.session", labelValue(metadata.sessionId)],
  ];
  return labels.flatMap(([key, value]) => value ? ["--label", `${key}=${value}`] : []);
}

export function resourceArgs(profileValue: ContainerRunProfile) {
  return [
    "--cpus", String(profileValue.cpus),
    "--memory", profileValue.memory,
    "--memory-swap", profileValue.memory,
    "--pids-limit", String(profileValue.pidsLimit),
    "--ulimit", "nofile=1024:1024",
  ];
}

export function securityArgs() {
  return [
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    "--user", "1000:1000",
  ];
}

export const containerRunProfileTestSupport = {
  parseMemoryBytes,
  getContainerRunProfile,
  managedContainerLabelArgs,
  resourceArgs,
  securityArgs,
};
