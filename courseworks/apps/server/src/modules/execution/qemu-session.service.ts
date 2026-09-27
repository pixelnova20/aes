/**
 * 文件作用：实现后端“沙箱执行、构建与 QEMU”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/execution/qemu-session.service.ts`，属于后端“沙箱执行、构建与 QEMU”业务模块。
 * 重要函数：`cleanupStaleWorkspaceRuntimes()` 负责处理`cleanup` `stale` 工作区 `runtimes`；`ensureWorkspaceRuntime()` 负责确保工作区 运行环境；`dockerArgs()` 负责处理`docker` `args`；`forceRemoveContainer()` 负责处理`force` `remove` `container`；`discoverVncPort()` 负责发现`vnc` `port`；`discoverRuntimeVncPort()` 负责发现运行环境 `vnc` `port`；`appendOutput()` 负责追加输出；`finalizeStatus()` 负责处理`finalize` 状态。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";

import { config } from "../../config/index.js";
import { assertWorkspaceExecutionAllowed, assertWorkspaceRoot } from "../workspaces/index.js";
import { tryAcquireExecutionAdmission, type ExecutionAdmissionLease } from "./execution-admission.service.js";
import { getContainerRunProfile, managedContainerLabelArgs, resourceArgs, securityArgs } from "./container-run-profile.js";
import { noteContainerActivity, noteContainerOutput, noteContainerProgress, registerManagedContainer, resourceLimitMessage, unregisterManagedContainer, type ResourceLimitReason } from "./container-resource-monitor.service.js";

const MAX_OUTPUT = 1024 * 1024;
const PLACEHOLDER_QEMU_MESSAGE = "QEMU is not available in MVP1.";
const UNPRIVILEGED_PING_SYSCTL = "net.ipv4.ping_group_range=0 2147483647";

export type QemuSessionStatus = "idle" | "running" | "stopped" | "failed" | "timeout" | "error" | "resource_limit_exceeded" | "idle_timeout";

export type QemuSessionSnapshot = {
  runId: string;
  status: QemuSessionStatus;
  output: string;
  exitCode: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
};

export type QemuSessionEvent =
  | { type: "output"; data: string }
  | { type: "status"; session: QemuSessionSnapshot };

export type QemuVncStatus = {
  state: "available" | "waiting_for_qemu" | "runtime_starting" | "session_stopped";
  message: string;
};

type ActiveQemuSession = {
  runId: string;
  workspaceId: string;
  kind: "qemu" | "shell";
  containerName: string;
  workspacePath: string;
  output: string;
  exitCode: number | null;
  status: Exclude<QemuSessionStatus, "idle">;
  startedAt: Date;
  finishedAt: Date | null;
  updatedAt: Date;
  child: ReturnType<typeof spawn>;
  vncHostPort: number | null;
  lease: ExecutionAdmissionLease;
  limitReason: ResourceLimitReason | null;
};

const sessions = new Map<string, ActiveQemuSession>();
const sessionListeners = new Map<string, Set<(event: QemuSessionEvent) => void>>();
type WorkspaceRuntime = {
  containerName: string;
  vncHostPort: number | null;
  lease: ExecutionAdmissionLease;
};
const workspaceRuntimes = new Map<string, WorkspaceRuntime>();

/**
 * 功能：处理`cleanup` `stale` 工作区 `runtimes`。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/app/server.ts 顶层流程` 调用；内部调用 `spawnSync()`、`split()`、`spawn()`。
 */
export function cleanupStaleWorkspaceRuntimes() {
  const listed = spawnSync("docker", ["ps", "-aq", "--filter", "label=courseworks.managed=true"], { encoding: "utf8" });
  const containerIds = listed.stdout.split(/\s+/).filter(Boolean);
  if (containerIds.length) {
    spawn("docker", ["rm", "-f", ...containerIds], { shell: false, stdio: "ignore" });
  }
}

/**
 * 功能：确保工作区 运行环境。
 * 输入：`workspaceId`（string）提供工作区 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/execution/qemu-session.service.ts:startInteractiveSession()` 调用；内部调用 `randomUUID()`、`spawnSync()`、`discoverRuntimeVncPort()`。
 */
function ensureWorkspaceRuntime(workspaceId: string, workspacePath: string) {
  const existing = workspaceRuntimes.get(workspaceId);
  if (existing) return existing;

  const containerName = `courseworks-runtime-${randomUUID()}`;
  const profile = getContainerRunProfile("runtime-sidecar");
  const lease = tryAcquireExecutionAdmission({ profiles: [profile], workspaceId, interactive: true });
  if (!lease) throw new Error("执行资源暂时繁忙，请稍后重试交互会话。");
  const result = spawnSync("docker", [
    "run", "-d", "--rm",
    "--name", containerName,
    ...managedContainerLabelArgs({ purpose: "runtime-sidecar", workspaceId }),
    "--network", config.DOCKER_RESTRICTED_NETWORK,
    "--sysctl", UNPRIVILEGED_PING_SYSCTL,
    "-p", "127.0.0.1::5900",
    "--dns", "223.5.5.5",
    "--dns", "1.1.1.1",
    "--read-only",
    "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=128m",
    ...resourceArgs(profile),
    ...securityArgs(),
    "-e", "HOME=/tmp/runner",
    "-e", "XDG_CONFIG_HOME=/tmp/runner/.config",
    "-e", "XDG_DATA_HOME=/tmp/runner/.local/share",
    "-e", "XDG_CACHE_HOME=/tmp/runner/.cache",
    "-e", "XDG_STATE_HOME=/tmp/runner/.local/state",
    config.DOCKER_TOOLBOX_IMAGE,
    "sleep", "infinity"
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    lease.release();
    throw new Error(result.stderr.trim() || "Unable to start workspace runtime.");
  }

  const runtime = { containerName, vncHostPort: null, lease };
  workspaceRuntimes.set(workspaceId, runtime);
  registerManagedContainer({
    containerName,
    profile,
    metadata: { workspaceId, workspacePath },
    onLimit: (reason) => {
      forceRemoveContainer(containerName);
      lease.release();
      for (const session of sessions.values()) {
        if (session.workspaceId !== workspaceId || session.status !== "running") continue;
        session.limitReason = reason;
        session.status = reason === "idle_timeout" ? "idle_timeout" : "resource_limit_exceeded";
        appendOutput(session, `\n${resourceLimitMessage(reason)}\n`);
        session.child.kill("SIGKILL");
      }
      workspaceRuntimes.delete(workspaceId);
    },
  });
  discoverRuntimeVncPort(runtime);
  return runtime;
}

/**
 * 功能：处理`docker` `args`。
 * 输入：`containerName`（string）提供container name。 `workspacePath`（string）提供工作区 路径。 `network`（string）提供network。 `command`（string[]）提供命令。 `namespaceContainer`（string）提供namespace container。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/execution/process-runner.service.ts:runWhitelistedMake()`、`apps/server/src/modules/execution/qemu-session.service.ts:startInteractiveSession()`、`apps/server/src/modules/execution/sandbox-command.service.ts:runSandboxCommand()` 调用。
 */
function dockerArgs(
  containerName: string,
  workspacePath: string,
  network: string,
  command: string[],
  namespaceContainer?: string,
  purpose: "qemu" | "shell" = "qemu",
  workspaceId?: string,
  runId?: string,
) {
  const profile = getContainerRunProfile(purpose);
  const networkArgs = namespaceContainer
    ? ["--network", `container:${namespaceContainer}`, "--pid", `container:${namespaceContainer}`]
    : [
        "--network", network,
        "--sysctl", UNPRIVILEGED_PING_SYSCTL,
        "-p", "127.0.0.1::5900",
        "--dns", "223.5.5.5",
        "--dns", "1.1.1.1",
      ];
  return [
    "run",
    "--rm",
    "-i",
    "--name", containerName,
    ...managedContainerLabelArgs({ purpose, workspaceId, runId, sessionId: runId }),
    ...networkArgs,
    "--read-only",
    "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=128m",
    ...resourceArgs(profile),
    ...securityArgs(),
    "-e", "TERM=xterm",
    "-e", "LANG=C.UTF-8",
    "-e", "LC_ALL=C.UTF-8",
    "-e", "LC_CTYPE=C.UTF-8",
    "-e", "HOME=/tmp/runner",
    "-e", "XDG_CONFIG_HOME=/tmp/runner/.config",
    "-e", "XDG_DATA_HOME=/tmp/runner/.local/share",
    "-e", "XDG_CACHE_HOME=/tmp/runner/.cache",
    "-e", "XDG_STATE_HOME=/tmp/runner/.local/state",
    "-v", `${workspacePath}:/home/runner/project:rw`,
    "-w", "/home/runner/project",
    config.DOCKER_TOOLBOX_IMAGE,
    ...command
  ];
}

/**
 * 功能：处理`force` `remove` `container`。
 * 输入：`containerName`（string）提供container name。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/execution/process-runner.service.ts:runWhitelistedMake()`、`apps/server/src/modules/execution/qemu-session.service.ts:maybeStopWorkspaceRuntime()`、`apps/server/src/modules/execution/qemu-session.service.ts:stopQemuSession()`、`apps/server/src/modules/execution/sandbox-command.service.ts:onAbort()`、`apps/server/src/modules/execution/sandbox-command.service.ts:runSandboxCommand()` 调用；内部调用 `spawn()`、`on()`。
 */
function forceRemoveContainer(containerName: string) {
  const child = spawn("docker", ["rm", "-f", containerName], { shell: false, stdio: "ignore" });
  child.on("error", () => undefined);
}

/**
 * 功能：发现`vnc` `port`。
 * 输入：`session`（ActiveQemuSession）提供会话。 `attempts`提供attempts。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/execution/qemu-session.service.ts:discoverVncPort()`、`apps/server/src/modules/execution/qemu-session.service.ts:startInteractiveSession()` 调用；内部调用 `spawn()`、`on()`、`toString()`、`match()`、`setTimeout()`、`discoverVncPort()`。
 */
function discoverVncPort(session: ActiveQemuSession, attempts = 20) {
  const inspect = spawn("docker", ["port", session.containerName, "5900/tcp"], { shell: false });
  let output = "";
  inspect.stdout.on("data", (chunk) => { output += chunk.toString(); });
  inspect.on("close", (code) => {
    const match = output.match(/127\.0\.0\.1:(\d+)/);
    if (code === 0 && match) {
      session.vncHostPort = Number(match[1]);
      session.updatedAt = new Date();
      return;
    }
    if (attempts > 0 && session.status === "running") {
      setTimeout(() => discoverVncPort(session, attempts - 1), 100);
    }
  });
}

/**
 * 功能：发现运行环境 `vnc` `port`。
 * 输入：`runtime`（WorkspaceRuntime）提供运行环境。 `attempts`提供attempts。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/execution/qemu-session.service.ts:ensureWorkspaceRuntime()`、`apps/server/src/modules/execution/qemu-session.service.ts:discoverRuntimeVncPort()` 调用；内部调用 `spawn()`、`on()`、`toString()`、`match()`、`setTimeout()`、`discoverRuntimeVncPort()`。
 */
function discoverRuntimeVncPort(runtime: WorkspaceRuntime, attempts = 20) {
  const inspect = spawn("docker", ["port", runtime.containerName, "5900/tcp"], { shell: false });
  let output = "";
  inspect.stdout.on("data", (chunk) => { output += chunk.toString(); });
  inspect.on("close", (code) => {
    const match = output.match(/127\.0\.0\.1:(\d+)/);
    if (code === 0 && match) {
      runtime.vncHostPort = Number(match[1]);
      return;
    }
    if (attempts > 0) setTimeout(() => discoverRuntimeVncPort(runtime, attempts - 1), 100);
  });
}

function refreshRuntimeVncPort(runtime: WorkspaceRuntime) {
  const inspected = spawnSync("docker", ["port", runtime.containerName, "5900/tcp"], { encoding: "utf8" });
  const match = inspected.stdout.match(/127\.0\.0\.1:(\d+)/);
  if (inspected.status === 0 && match) runtime.vncHostPort = Number(match[1]);
}

function canConnectToVnc(target: { host: string; port: number }) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(target);
    let settled = false;
    let banner = "";
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(available);
    };
    socket.setTimeout(750, () => finish(false));
    socket.on("data", (chunk) => {
      banner += chunk.toString("ascii");
      if (banner.length >= 12) finish(/^RFB \d{3}\.\d{3}\n/.test(banner));
    });
    socket.once("end", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * 功能：追加输出。
 * 输入：`session`（ActiveQemuSession）提供会话。 `chunk`（Buffer | string）提供chunk。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/modules/execution/qemu-session.service.ts:startInteractiveSession()`、`apps/server/src/modules/execution/qemu-session.service.ts:stopQemuSession()` 调用；内部调用 `replace()`、`toString()`。
 */
function appendOutput(session: ActiveQemuSession, chunk: Buffer | string) {
  // 浏览器当前以纯文本渲染终端输出；隐藏 Bash 的 bracketed-paste 控制序列，同时保留普通串口输出。
  const text = (typeof chunk === "string" ? chunk : chunk.toString()).replace(/\x1b\[\?2004[hl]/g, "");
  session.output = (session.output + text).slice(-MAX_OUTPUT);
  session.updatedAt = new Date();
  noteContainerOutput(session.containerName, Buffer.byteLength(text));
  noteContainerProgress(session.containerName);
  publishSessionEvent(session.runId, { type: "output", data: text });
}

function publishSessionEvent(runId: string, event: QemuSessionEvent) {
  for (const listener of sessionListeners.get(runId) ?? []) {
    try {
      listener(event);
    } catch {
      // A broken browser subscriber must not interrupt the process output path.
    }
  }
}

/**
 * 功能：处理`finalize` 状态。
 * 输入：`session`（ActiveQemuSession）提供会话。 `code`（number | null）提供代码。 `signal`（NodeJS.Signals | null）提供signal。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/execution/qemu-session.service.ts:startInteractiveSession()` 调用；内部调用 `includes()`。
 */
function finalizeStatus(session: ActiveQemuSession, code: number | null, signal: NodeJS.Signals | null) {
  session.exitCode = code;
  session.finishedAt = new Date();
  session.updatedAt = session.finishedAt;
  if (session.limitReason) {
    publishSessionEvent(session.runId, { type: "status", session: toSnapshot(session, session.runId) });
    return;
  }

  if (session.kind === "qemu" && session.output.includes(PLACEHOLDER_QEMU_MESSAGE)) {
    session.status = "failed";
    session.output = `${session.output.trim()}

Detected placeholder Makefile target instead of a real QEMU run pipeline.`.trim();
    publishSessionEvent(session.runId, { type: "status", session: toSnapshot(session, session.runId) });
    return;
  }

  if (signal === "SIGKILL") {
    session.status = session.status === "timeout" ? "timeout" : "stopped";
    publishSessionEvent(session.runId, { type: "status", session: toSnapshot(session, session.runId) });
    return;
  }

  session.status = code === 0 ? "stopped" : "failed";
  publishSessionEvent(session.runId, { type: "status", session: toSnapshot(session, session.runId) });
}

/**
 * 功能：处理`maybe` `stop` 工作区 运行环境。
 * 输入：`workspaceId`（string）提供工作区 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/execution/qemu-session.service.ts:startInteractiveSession()` 调用；内部调用 `some()`、`values()`、`forceRemoveContainer()`、`delete()`。
 */
function maybeStopWorkspaceRuntime(workspaceId: string) {
  const hasRunningShell = [...sessions.values()].some(
    (session) => session.workspaceId === workspaceId && session.kind === "shell" && session.status === "running"
  );
  if (hasRunningShell) return;
  const runtime = workspaceRuntimes.get(workspaceId);
  if (!runtime) return;
  forceRemoveContainer(runtime.containerName);
  unregisterManagedContainer(runtime.containerName);
  runtime.lease.release();
  workspaceRuntimes.delete(workspaceId);
}

/**
 * 功能：处理`to` `snapshot`。
 * 输入：`session`（ActiveQemuSession | undefined）提供会话。 `runId`（string）提供运行 id。
 * 输出：返回 QemuSessionSnapshot，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/execution/qemu-session.service.ts:getQemuSessionSnapshot()`、`apps/server/src/modules/execution/qemu-session.service.ts:startInteractiveSession()`、`apps/server/src/modules/execution/qemu-session.service.ts:listWorkspaceShells()`、`apps/server/src/modules/execution/qemu-session.service.ts:resizeWorkspaceShell()`、`apps/server/src/modules/execution/qemu-session.service.ts:sendQemuSessionInput()` 调用；内部调用 `toISOString()`。
 */
function toSnapshot(session: ActiveQemuSession | undefined, runId: string): QemuSessionSnapshot {
  if (!session) {
    return {
      runId,
      status: "idle",
      output: "",
      exitCode: null,
      startedAt: null,
      finishedAt: null,
      updatedAt: null
    };
  }

  return {
    runId,
    status: session.status,
    output: session.output,
    exitCode: session.exitCode,
    startedAt: session.startedAt.toISOString(),
    finishedAt: session.finishedAt ? session.finishedAt.toISOString() : null,
    updatedAt: session.updatedAt.toISOString()
  };
}

/**
 * 功能：获取QEMU 会话 `snapshot`。
 * 输入：`runId`（string）提供运行 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:getAgentQemuSession()`、`apps/server/src/application/workspace/workspace-application.service.ts:getWorkspaceLab()` 调用；内部调用 `toSnapshot()`。
 */
export function getQemuSessionSnapshot(runId: string) {
  return toSnapshot(sessions.get(runId), runId);
}

/** Subscribe to live terminal output and lifecycle changes for one interactive session. */
export function subscribeQemuSession(
  runId: string,
  listener: (event: QemuSessionEvent) => void,
) {
  if (!sessions.has(runId)) throw new Error("交互式工作区会话不存在。");
  const listeners = sessionListeners.get(runId) ?? new Set<(event: QemuSessionEvent) => void>();
  listeners.add(listener);
  sessionListeners.set(runId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) sessionListeners.delete(runId);
  };
}

/**
 * 功能：获取QEMU `vnc` 目标。
 * 输入：`runId`（string）提供运行 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/execution/vnc-bridge.service.ts:attachVncBridge()` 调用。
 */
export function getQemuVncTarget(runId: string) {
  const session = sessions.get(runId);
  if (!session || session.status !== "running") return null;
  const runtimePort = workspaceRuntimes.get(session.workspaceId)?.vncHostPort;
  const port = runtimePort ?? session.vncHostPort;
  return port ? { host: "127.0.0.1", port } : null;
}

/** Probe both the published Docker port and the QEMU VNC listener behind it. */
export async function getQemuVncStatus(runId: string): Promise<QemuVncStatus> {
  const session = sessions.get(runId);
  if (!session || session.status !== "running") {
    return { state: "session_stopped", message: "所选实验会话未在运行。" };
  }

  const runtime = workspaceRuntimes.get(session.workspaceId);
  if (runtime && !runtime.vncHostPort) refreshRuntimeVncPort(runtime);
  const target = getQemuVncTarget(runId);
  if (!target) {
    return { state: "runtime_starting", message: "实验 VNC 桥接端口仍在准备中。" };
  }
  if (!await canConnectToVnc(target)) {
    return {
      state: "waiting_for_qemu",
      message: "没有 QEMU VNC 服务正在监听，请在实验终端中启动带图形界面的 QEMU 命令。",
    };
  }
  return { state: "available", message: "QEMU VNC 已开始监听，浏览器可以连接。" };
}

/**
 * 功能：启动`interactive` 会话。
 * 输入：`runId`（string）提供运行 id。 `workspaceId`（string）提供工作区 id。 `workspacePath`（string）提供工作区 路径。 `kind`（"qemu" | "shell"）提供kind。 `network`（string）提供network。 `command`（string[]）提供命令。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/execution/qemu-session.service.ts:startQemuSession()`、`apps/server/src/modules/execution/qemu-session.service.ts:startWorkspaceShell()`、`apps/server/src/modules/execution/qemu-session.service.ts:createWorkspaceShell()` 调用；内部调用 `assertWorkspaceRoot()`、`resolve()`、`randomUUID()`、`ensureWorkspaceRuntime()`、`spawn()`、`dockerArgs()`。
 */
async function startInteractiveSession(
  runId: string,
  workspaceId: string,
  workspacePath: string,
  kind: "qemu" | "shell",
  network: string,
  command: string[]
) {
  const existing = sessions.get(runId);
  if (existing?.status === "running") {
    throw new Error("已有交互式工作区会话正在运行。");
  }

  try {
    assertWorkspaceRoot(workspacePath);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Invalid workspace path.");
  }

  const resolvedWorkspace = path.resolve(workspacePath);
  await assertWorkspaceExecutionAllowed(resolvedWorkspace);
  const containerName = `courseworks-${kind}-${randomUUID()}`;
  const profile = getContainerRunProfile(kind === "shell" ? "shell" : "qemu");
  const lease = tryAcquireExecutionAdmission({ profiles: [profile], workspaceId, interactive: true });
  if (!lease) throw new Error("执行资源暂时繁忙，请稍后重试交互会话。");
  let runtime: WorkspaceRuntime | null = null;
  try {
    runtime = kind === "shell" ? ensureWorkspaceRuntime(workspaceId, resolvedWorkspace) : null;
  } catch (error) {
    lease.release();
    throw error;
  }
  const child = spawn("docker", dockerArgs(containerName, resolvedWorkspace, network, command, runtime?.containerName, kind, workspaceId, runId), {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });

  const session: ActiveQemuSession = {
    runId,
    workspaceId,
    kind,
    containerName,
    workspacePath: resolvedWorkspace,
    output: "",
    exitCode: null,
    status: "running",
    startedAt: new Date(),
    finishedAt: null,
    updatedAt: new Date(),
    child,
    vncHostPort: null,
    lease,
    limitReason: null,
  };

  sessions.set(runId, session);
  if (!runtime) discoverVncPort(session);
  registerManagedContainer({
    containerName,
    profile,
    metadata: { workspaceId, runId, workspacePath: resolvedWorkspace },
    onLimit: (reason) => {
      session.limitReason = reason;
      session.status = reason === "idle_timeout" ? "idle_timeout" : "resource_limit_exceeded";
      appendOutput(session, `\n${resourceLimitMessage(reason)}\n`);
      forceRemoveContainer(containerName);
      child.kill("SIGKILL");
    },
  });

  child.stdout.on("data", (chunk) => appendOutput(session, chunk));
  child.stderr.on("data", (chunk) => appendOutput(session, chunk));
  child.on("error", (error) => {
    appendOutput(session, `
[runner error] ${error.message}
`);
    session.status = "error";
    session.finishedAt = new Date();
    session.updatedAt = session.finishedAt;
    unregisterManagedContainer(containerName);
    session.lease.release();
  });
  child.on("close", (code, signal) => {
    finalizeStatus(session, code, signal);
    unregisterManagedContainer(containerName);
    session.lease.release();
    maybeStopWorkspaceRuntime(session.workspaceId);
  });

  return toSnapshot(session, runId);
}

/**
 * 功能：启动QEMU 会话。
 * 输入：`runId`（string）提供运行 id。 `workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:startAgentQemuSession()` 调用；内部调用 `startInteractiveSession()`。
 */
export async function startQemuSession(runId: string, workspaceId: string, workspacePath: string) {
  return startInteractiveSession(
    runId,
    workspaceId,
    workspacePath,
    "qemu",
    config.DOCKER_RESTRICTED_NETWORK,
    ["make", "run"]
  );
}

/** 以学生工程目录为根启动受沙箱限制的 Bash shell。 */
/**
 * 功能：启动工作区 终端会话。
 * 输入：`sessionId`（string）提供会话 id。 `workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:startWorkspaceLab()` 调用；内部调用 `startInteractiveSession()`。
 */
export async function startWorkspaceShell(sessionId: string, workspacePath: string) {
  return startInteractiveSession(
    sessionId,
    sessionId,
    workspacePath,
    "shell",
    config.DOCKER_RESTRICTED_NETWORK,
    ["script", "-qfec", "stty cols 80 rows 24; exec bash --noprofile --norc -i", "/dev/null"]
  );
}

/**
 * 功能：创建工作区 终端会话。
 * 输入：`workspaceId`（string）提供工作区 id。 `workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:createWorkspaceLabShell()` 调用；内部调用 `values()`、`randomUUID()`、`startInteractiveSession()`。
 */
export async function createWorkspaceShell(workspaceId: string, workspacePath: string) {
  const active = [...sessions.values()].filter((session) => session.workspaceId === workspaceId && session.kind === "shell" && session.status === "running");
  if (active.length >= config.EXECUTION_MAX_SHELL_PER_WORKSPACE) {
    throw new Error(`每个工作区最多可以有 ${config.EXECUTION_MAX_SHELL_PER_WORKSPACE} 个活动终端。`);
  }
  const sessionId = `${workspaceId}:shell:${randomUUID()}`;
  return startInteractiveSession(
    sessionId,
    workspaceId,
    workspacePath,
    "shell",
    config.DOCKER_RESTRICTED_NETWORK,
    ["script", "-qfec", "stty cols 80 rows 24; exec bash --noprofile --norc -i", "/dev/null"]
  );
}

/**
 * 功能：列出工作区 `shells`。
 * 输入：`workspaceId`（string）提供工作区 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:getWorkspaceLab()` 调用；内部调用 `sort()`、`values()`、`getTime()`、`toSnapshot()`。
 */
export function listWorkspaceShells(workspaceId: string) {
  return [...sessions.values()]
    .filter((session) => (
      session.workspaceId === workspaceId
      && session.kind === "shell"
      && session.status === "running"
    ))
    .sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime())
    .map((session) => toSnapshot(session, session.runId));
}

/** 终止并忘记普通 OS Lab 中属于指定工作区的全部运行态，不影响工作区文件。 */
export function resetWorkspaceLabSessions(workspaceId: string) {
  for (const [sessionId, session] of sessions) {
    if (session.workspaceId !== workspaceId) continue;
    sessions.delete(sessionId);
    if (session.status !== "running") continue;
    forceRemoveContainer(session.containerName);
    unregisterManagedContainer(session.containerName);
    session.lease.release();
    session.child.stdin?.end();
    session.child.kill("SIGKILL");
  }

  const runtime = workspaceRuntimes.get(workspaceId);
  if (runtime) {
    workspaceRuntimes.delete(workspaceId);
    forceRemoveContainer(runtime.containerName);
    unregisterManagedContainer(runtime.containerName);
    runtime.lease.release();
  }
}

export function getWorkspaceShellLimit() {
  return config.EXECUTION_MAX_SHELL_PER_WORKSPACE;
}

/**
 * 功能：处理工作区 `owns` 终端会话。
 * 输入：`workspaceId`（string）提供工作区 id。 `sessionId`（string）提供会话 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:getOwnedWorkspaceShell()`、`apps/server/src/modules/execution/vnc-bridge.service.ts:attachVncBridge()` 调用。
 */
export function workspaceOwnsShell(workspaceId: string, sessionId: string) {
  const session = sessions.get(sessionId);
  return Boolean(session && session.workspaceId === workspaceId && session.kind === "shell");
}

/** Check ownership for either a Bash shell or an Agent Run QEMU session. */
export function workspaceOwnsInteractiveSession(workspaceId: string, sessionId: string) {
  return sessions.get(sessionId)?.workspaceId === workspaceId;
}

/** 让 PTY 尺寸与浏览器终端的实际字符网格保持一致。 */
/**
 * 功能：调整大小工作区 终端会话。
 * 输入：`sessionId`（string）提供会话 id。 `columns`（number）提供columns。 `rows`（number）提供rows。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:resizeWorkspaceLabShell()` 调用；内部调用 `spawnSync()`、`find()`、`split()`、`test()`、`toSnapshot()`。
 */
export async function resizeWorkspaceShell(sessionId: string, columns: number, rows: number) {
  const attempts = 20;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const session = sessions.get(sessionId);
    if (!session || session.kind !== "shell" || session.status !== "running") {
      throw new Error("交互式工作区会话未在运行。");
    }

    // shell 与 runtime 共享 PID namespace；宿主侧 docker top 会把其 TTY 显示为 "?"，
    // 必须从 shell 容器内部读取 /dev/pts 对应的进程信息。
    const listed = spawnSync("docker", [
      "exec", "--user", "1000:1000", session.containerName,
      "ps", "-eo", "pid,tty,comm"
    ], { encoding: "utf8" });
    const terminal = listed.status === 0
      ? listed.stdout
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/)[1])
        .find((tty) => /^pts\/\d+$/.test(tty))
      : undefined;

    if (terminal) {
      const resized = spawnSync("docker", [
        "exec", "--user", "1000:1000", session.containerName,
        "stty", "-F", `/dev/${terminal}`, "cols", String(columns), "rows", String(rows)
      ], { encoding: "utf8" });
      if (resized.status === 0) {
        session.updatedAt = new Date();
        return toSnapshot(session, sessionId);
      }
      if (attempt === attempts - 1) {
        throw new Error(resized.stderr.trim() || "无法调整工作区终端大小。");
      }
    } else if (attempt === attempts - 1) {
      throw new Error(listed.status === 0
        ? "工作区终端尚未就绪。"
        : listed.stderr.trim() || "无法检查工作区终端。");
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error("工作区终端尚未就绪。");
}

/**
 * 功能：发送QEMU 会话 结构化输入。
 * 输入：`runId`（string）提供运行 id。 `input`（string）提供当前操作所需的结构化输入。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:sendAgentQemuInput()`、`apps/server/src/application/workspace/workspace-application.service.ts:sendWorkspaceLabShellInput()`、`apps/server/src/application/workspace/workspace-application.service.ts:sendWorkspaceLabInput()` 调用；内部调用 `write()`、`toSnapshot()`。
 */
export function sendQemuSessionInput(runId: string, input: string) {
  const session = sessions.get(runId);
  if (!session || session.status !== "running") {
    throw new Error("交互式工作区会话未在运行。");
  }

  session.child.stdin?.write(input);
  session.updatedAt = new Date();
  noteContainerActivity(session.containerName);
  return toSnapshot(session, runId);
}

/**
 * 功能：停止QEMU 会话。
 * 输入：`runId`（string）提供运行 id。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:stopAgentQemuSession()`、`apps/server/src/application/workspace/workspace-application.service.ts:closeWorkspaceLabShell()`、`apps/server/src/application/workspace/workspace-application.service.ts:stopWorkspaceLab()` 调用；内部调用 `toSnapshot()`、`appendOutput()`、`forceRemoveContainer()`、`end()`、`kill()`。
 */
export function stopQemuSession(runId: string) {
  const session = sessions.get(runId);
  if (!session) {
    return toSnapshot(undefined, runId);
  }

  if (session.status === "running") {
    appendOutput(session, `\n[interactive session stop requested]\n`);
    forceRemoveContainer(session.containerName);
    session.child.stdin?.end();
    session.child.kill("SIGKILL");
  }

  return toSnapshot(session, runId);
}
