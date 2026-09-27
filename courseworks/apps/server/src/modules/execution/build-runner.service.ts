/**
 * 文件作用：实现后端“沙箱执行、构建与 QEMU”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/execution/build-runner.service.ts`，属于后端“沙箱执行、构建与 QEMU”业务模块。
 * 重要函数：`normalizeBuildResult()` 负责规范化构建结果 结果；`runMakeBuild()` 负责执行`make` 构建结果。
 */
import { prisma } from "../../infrastructure/prisma/client.js";
import { runWhitelistedMake } from "./process-runner.service.js";
import { summarizeBuildLog } from "./build-log.js";

const PLACEHOLDER_BUILD_MESSAGE = "Build is not available in MVP1.";

type RunnerResult = { status: "success" | "failed" | "timeout" | "error" | "resource_limit_exceeded" | "idle_timeout"; exitCode: number | null; output: string; limitReason?: string };

/**
 * 功能：规范化构建结果 结果。
 * 输入：`result`（RunnerResult）提供结果。
 * 输出：返回 RunnerResult，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/execution/build-runner.service.ts:runMakeBuild()` 调用；内部调用 `includes()`。
 */
function normalizeBuildResult(result: RunnerResult): RunnerResult {
  if (result.status === "success" && result.output.includes(PLACEHOLDER_BUILD_MESSAGE)) {
    return {
      ...result,
      status: "failed" as const,
      output: `${result.output.trim()}

Detected placeholder Makefile target instead of a real build pipeline.`.trim()
    };
  }
  return result;
}

/** 只在当前工作区执行 `make`，并持久化经过长度限制的日志。 */
/**
 * 功能：执行`make` 构建结果。
 * 输入：`agentRunId`（string）提供Agent 运行 id。 `workspace`（{ id: string; path: string }）提供工作区。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:buildAgentRun()` 调用；内部调用 `runWhitelistedMake()`、`normalizeBuildResult()`、`summarizeBuildLog()`、`create()`。
 */
export async function runMakeBuild(agentRunId: string, workspace: { id: string; path: string }) {
  const startedAt = new Date();
  const rawResult = await runWhitelistedMake(workspace.path, [], 30000, { workspaceId: workspace.id, runId: agentRunId });
  const result = normalizeBuildResult(rawResult);
  const logSummaryMarkdown = summarizeBuildLog(result.output, result.status);
  return prisma.buildRun.create({
    data: {
      agentRunId,
      workspaceId: workspace.id,
      status: result.status,
      exitCode: result.exitCode,
      log: result.output,
      logSummaryMarkdown,
      startedAt,
      finishedAt: new Date()
    }
  });
}
