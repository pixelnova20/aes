/**
 * 文件作用：实现后端“沙箱执行、构建与 QEMU”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/execution/process-runner.service.ts`，属于后端“沙箱执行、构建与 QEMU”业务模块。
 * 重要函数：`isSafeMakeArg()` 负责判断是否为`safe` `make` `arg`；`dockerArgs()` 负责处理`docker` `args`；`forceRemoveContainer()` 负责处理`force` `remove` `container`；`runWhitelistedMake()` 负责执行`whitelisted` `make`。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { config } from "../../config/index.js";
import { assertWorkspaceExecutionAllowed, assertWorkspaceRoot } from "../workspaces/index.js";
import { acquireExecutionAdmission } from "./execution-admission.service.js";
import { getContainerRunProfile, managedContainerLabelArgs, resourceArgs, securityArgs } from "./container-run-profile.js";
import { noteContainerOutput, noteContainerProgress, registerManagedContainer, resourceLimitMessage, unregisterManagedContainer, type ResourceLimitReason } from "./container-resource-monitor.service.js";

const MAX_OUTPUT = 1024 * 1024;

export type RunnerStatus = "success" | "failed" | "timeout" | "error" | "resource_limit_exceeded" | "idle_timeout";
export type RunnerResult = { status: RunnerStatus; exitCode: number | null; output: string; limitReason?: ResourceLimitReason };

/**
 * 功能：判断是否为`safe` `make` `arg`。
 * 输入：`arg`（string）提供arg。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/execution/process-runner.service.ts:runWhitelistedMake()` 调用；内部调用 `test()`、`startsWith()`。
 */
function isSafeMakeArg(arg: string) {
  return /^[A-Za-z0-9_.:-]+$/.test(arg) && !arg.startsWith("-");
}

/**
 * 功能：处理`docker` `args`。
 * 输入：`containerName`（string）提供container name。 `workspacePath`（string）提供工作区 路径。 `makeArgs`（string[]）提供make args。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/execution/process-runner.service.ts:runWhitelistedMake()`、`apps/server/src/modules/execution/qemu-session.service.ts:startInteractiveSession()`、`apps/server/src/modules/execution/sandbox-command.service.ts:runSandboxCommand()` 调用。
 */
function dockerArgs(containerName: string, workspacePath: string, makeArgs: string[], metadata: { workspaceId?: string; runId?: string; purpose?: "build" | "qemu" }) {
  const purpose = metadata.purpose ?? "build";
  const profile = getContainerRunProfile(purpose);
  return [
    "run",
    "--rm",
    "--name", containerName,
    ...managedContainerLabelArgs({ purpose, workspaceId: metadata.workspaceId, runId: metadata.runId }),
    "--network", "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=128m",
    ...resourceArgs(profile),
    ...securityArgs(),
    "-e", "HOME=/tmp/runner",
    "-e", "XDG_CONFIG_HOME=/tmp/runner/.config",
    "-e", "XDG_DATA_HOME=/tmp/runner/.local/share",
    "-e", "XDG_CACHE_HOME=/tmp/runner/.cache",
    "-e", "XDG_STATE_HOME=/tmp/runner/.local/state",
    "-v", `${workspacePath}:/home/runner/project:rw`,
    "-w", "/home/runner/project",
    config.DOCKER_TOOLBOX_IMAGE,
    "make",
    ...makeArgs
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
 * 功能：执行`whitelisted` `make`。
 * 输入：`workspacePath`（string）提供工作区 路径。 `args`（string[]）提供args。 `timeoutMs`（number）提供timeout ms。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/execution/build-runner.service.ts:runMakeBuild()`、`apps/server/src/modules/execution/qemu-smoke-runner.service.ts:runQemuSmoke()` 调用；内部调用 `assertWorkspaceRoot()`、`resolve()`、`some()`、`isSafeMakeArg()`、`randomUUID()`、`spawn()`。
 */
export async function runWhitelistedMake(workspacePath: string, args: string[], timeoutMs: number, metadata: { workspaceId?: string; runId?: string; purpose?: "build" | "qemu" } = {}) {
  try {
    assertWorkspaceRoot(workspacePath);
    await assertWorkspaceExecutionAllowed(workspacePath);
  } catch (error) {
    return { status: "error" as const, exitCode: null, output: error instanceof Error ? error.message : "Invalid workspace path." };
  }

  if (args.some((arg) => !isSafeMakeArg(arg))) {
    return { status: "error" as const, exitCode: null, output: "Rejected unsafe make argument." };
  }

  const purpose = metadata.purpose ?? "build";
  const profile = getContainerRunProfile(purpose);
  let lease;
  try {
    lease = await acquireExecutionAdmission({ profiles: [profile], workspaceId: metadata.workspaceId });
  } catch (error) {
    return { status: "error" as const, exitCode: null, output: error instanceof Error ? error.message : "Execution resources are temporarily busy." };
  }

  return new Promise<RunnerResult>((resolve) => {
    try {
      const resolvedWorkspace = path.resolve(workspacePath);
      const containerName = `courseworks-runner-${randomUUID()}`;
      const child = spawn("docker", dockerArgs(containerName, resolvedWorkspace, args, metadata), { shell: false });
    let output = "";
    let timedOut = false;
    let settled = false;
    let resourceLimitReason: ResourceLimitReason | undefined;
    const append = (chunk: Buffer) => {
      noteContainerOutput(containerName, chunk.byteLength);
      noteContainerProgress(containerName);
      output = (output + chunk.toString()).slice(-Math.min(MAX_OUTPUT, config.EXECUTION_OUTPUT_MAX_BYTES));
    };
    const onLimit = (reason: ResourceLimitReason) => {
      resourceLimitReason = reason;
      output = `${output}\n[resource limit exceeded: ${reason}]\n`.slice(-MAX_OUTPUT);
      forceRemoveContainer(containerName);
      child.kill("SIGKILL");
    };
    registerManagedContainer({ containerName, profile, metadata: { ...metadata, workspacePath: resolvedWorkspace }, onLimit });
    const timer = setTimeout(() => {
      timedOut = true;
      forceRemoveContainer(containerName);
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unregisterManagedContainer(containerName);
      lease.release();
      resolve({ status: "error", exitCode: null, output: error.message });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unregisterManagedContainer(containerName);
      lease.release();
      if (resourceLimitReason) resolve({ status: resourceLimitReason === "idle_timeout" ? "idle_timeout" : "resource_limit_exceeded", exitCode: code, output: `${output}\n${resourceLimitMessage(resourceLimitReason)}\n`.slice(-MAX_OUTPUT), limitReason: resourceLimitReason });
      else if (timedOut || signal === "SIGKILL") resolve({ status: "timeout", exitCode: code, output });
      else resolve({ status: code === 0 ? "success" : "failed", exitCode: code, output });
    });
    } catch (error) {
      lease.release();
      resolve({ status: "error", exitCode: null, output: error instanceof Error ? error.message : "Unable to start build container." });
    }
  });
}
