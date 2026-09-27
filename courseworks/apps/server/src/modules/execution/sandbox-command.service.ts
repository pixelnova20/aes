/**
 * 文件作用：实现后端“沙箱执行、构建与 QEMU”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/execution/sandbox-command.service.ts`，属于后端“沙箱执行、构建与 QEMU”业务模块。
 * 重要函数：`dockerArgs()` 负责处理`docker` `args`；`forceRemoveContainer()` 负责处理`force` `remove` `container`；`runSandboxCommand()` 负责执行`sandbox` 命令。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../../config/index.js";
import { SANDBOX_UPLOADS_PATH, uploadsRoot } from "../artifacts/index.js";
import { assertWorkspaceExecutionAllowed, assertWorkspaceRoot } from "../workspaces/index.js";
import { acquireExecutionAdmission } from "./execution-admission.service.js";
import {
  getContainerRunProfile,
  managedContainerLabelArgs,
  resourceArgs,
  securityArgs,
} from "./container-run-profile.js";
import {
  noteContainerOutput,
  noteContainerProgress,
  registerManagedContainer,
  resourceLimitMessage,
  unregisterManagedContainer,
  type ResourceLimitReason,
} from "./container-resource-monitor.service.js";

/**
 * 功能：处理`docker` `args`。
 * 输入：`containerName`（string）提供container name。 `workspacePath`（string）提供工作区 路径。 `attachmentPath`（string）提供attachment 路径。 `command`（string）提供命令。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/execution/process-runner.service.ts:runWhitelistedMake()`、`apps/server/src/modules/execution/qemu-session.service.ts:startInteractiveSession()`、`apps/server/src/modules/execution/sandbox-command.service.ts:runSandboxCommand()` 调用。
 */
function dockerArgs(
  containerName: string,
  workspacePath: string,
  attachmentPath: string,
  command: string,
  metadata: { workspaceId?: string; runId?: string; userId?: string },
) {
  const profile = getContainerRunProfile("agent-bash");
  return [
    "run",
    "--rm",
    "--name",
    containerName,
    ...managedContainerLabelArgs({ purpose: "agent-bash", workspaceId: metadata.workspaceId, runId: metadata.runId, userId: metadata.userId }),
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,exec,nosuid,nodev,size=128m",
    ...resourceArgs(profile),
    ...securityArgs(),
    "-e",
    "HOME=/tmp/runner",
    "-e",
    "XDG_CONFIG_HOME=/tmp/runner/.config",
    "-e",
    "XDG_DATA_HOME=/tmp/runner/.local/share",
    "-e",
    "XDG_CACHE_HOME=/tmp/runner/.cache",
    "-e",
    "XDG_STATE_HOME=/tmp/runner/.local/state",
    "-v",
    `${workspacePath}:/home/runner/project:rw`,
    "-v",
    `${attachmentPath}:${SANDBOX_UPLOADS_PATH}:ro`,
    "-w",
    "/home/runner/project",
    config.DOCKER_TOOLBOX_IMAGE,
    "sh",
    "-lc",
    command,
  ];
}

/**
 * 功能：处理`force` `remove` `container`。
 * 输入：`containerName`（string）提供container name。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/execution/process-runner.service.ts:runWhitelistedMake()`、`apps/server/src/modules/execution/qemu-session.service.ts:maybeStopWorkspaceRuntime()`、`apps/server/src/modules/execution/qemu-session.service.ts:stopQemuSession()`、`apps/server/src/modules/execution/sandbox-command.service.ts:onAbort()`、`apps/server/src/modules/execution/sandbox-command.service.ts:runSandboxCommand()` 调用；内部调用 `spawn()`、`on()`。
 */
function forceRemoveContainer(containerName: string) {
  const child = spawn("docker", ["rm", "-f", containerName], {
    shell: false,
    stdio: "ignore",
  });
  child.on("error", () => undefined);
}

/**
 * 功能：执行`sandbox` 命令。
 * 输入：`args`（{ workspacePath: string; command: string; timeoutSeconds?: number; signal?: AbortSignal; onData: (data: Buffer) => void;）提供args。
 * 输出：返回 Promise<{ exitCode: number | null }>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:exec()` 调用；内部调用 `assertWorkspaceRoot()`、`resolve()`、`uploadsRoot()`、`mkdir()`、`randomUUID()`、`reject()`。
 */
export async function runSandboxCommand(args: {
  workspacePath: string;
  command: string;
  timeoutSeconds?: number;
  signal?: AbortSignal;
  onData: (data: Buffer) => void;
  metadata?: { workspaceId?: string; runId?: string; userId?: string };
}): Promise<{ exitCode: number | null }> {
  assertWorkspaceRoot(args.workspacePath);
  const workspacePath = path.resolve(args.workspacePath);
  await assertWorkspaceExecutionAllowed(workspacePath);
  const attachmentPath = uploadsRoot(workspacePath);
  await fs.mkdir(attachmentPath, { recursive: true, mode: 0o700 });
  const containerName = `courseworks-agent-${randomUUID()}`;
  const timeoutSeconds = Math.max(
    1,
    Math.min(
      args.timeoutSeconds ?? config.EXECUTION_TOOL_TIMEOUT_DEFAULT_SECONDS,
      config.EXECUTION_TOOL_TIMEOUT_HARD_MAX_SECONDS,
    ),
  );
  const profile = getContainerRunProfile("agent-bash");
  const lease = await acquireExecutionAdmission({ profiles: [profile] });

  return new Promise((resolve, reject) => {
    if (args.signal?.aborted) {
      lease.release();
      reject(new Error("aborted"));
      return;
    }

    const child = spawn(
      "docker",
      dockerArgs(containerName, workspacePath, attachmentPath, args.command, args.metadata ?? {}),
      {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let settled = false;
    let timedOut = false;
    let resourceLimitReason: ResourceLimitReason | null = null;
    let outputBytes = 0;
    let outputTruncated = false;

    /**
     * 功能：处理`finish`。
     * 输入：`action`（() => void）提供action。
     * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
     * 调用关系：由 `apps/server/src/modules/execution/sandbox-command.service.ts:onAbort()`、`apps/server/src/modules/execution/sandbox-command.service.ts:runSandboxCommand()` 调用；内部调用 `clearTimeout()`、`removeEventListener()`、`action()`。
     */
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onAbort);
      unregisterManagedContainer(containerName);
      lease.release();
      action();
    };
    /**
     * 功能：处理`on` `abort`。
     * 输入：无显式输入参数。
     * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
     * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `forceRemoveContainer()`、`kill()`、`finish()`、`reject()`。
     */
    const onAbort = () => {
      forceRemoveContainer(containerName);
      child.kill("SIGKILL");
      finish(() => reject(new Error("aborted")));
    };
    const onLimit = (reason: ResourceLimitReason) => {
      resourceLimitReason = reason;
      forceRemoveContainer(containerName);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      forceRemoveContainer(containerName);
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);

    const forwardData = (chunk: Buffer) => {
      noteContainerOutput(containerName, chunk.byteLength);
      noteContainerProgress(containerName);
      if (outputBytes >= config.EXECUTION_OUTPUT_MAX_BYTES) return;
      const remaining = config.EXECUTION_OUTPUT_MAX_BYTES - outputBytes;
      const visible = chunk.subarray(0, remaining);
      outputBytes += visible.byteLength;
      args.onData(visible);
      if (visible.byteLength < chunk.byteLength && !outputTruncated) {
        outputTruncated = true;
        args.onData(Buffer.from("\n[output truncated by Courseworks resource limit]\n"));
      }
    };
    registerManagedContainer({ containerName, profile, metadata: { ...args.metadata, workspacePath }, onLimit });
    child.stdout.on("data", forwardData);
    child.stderr.on("data", forwardData);
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (exitCode) => {
      if (timedOut) {
        finish(() => reject(new Error(`timeout:${timeoutSeconds}`)));
        return;
      }
      if (resourceLimitReason) {
        const reason = resourceLimitReason;
        finish(() => reject(new Error(resourceLimitMessage(reason))));
        return;
      }
      finish(() => resolve({ exitCode }));
    });
    args.signal?.addEventListener("abort", onAbort, { once: true });
  });
}
