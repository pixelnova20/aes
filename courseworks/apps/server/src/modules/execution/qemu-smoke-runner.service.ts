/**
 * 文件作用：实现后端“沙箱执行、构建与 QEMU”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/execution/qemu-smoke-runner.service.ts`，属于后端“沙箱执行、构建与 QEMU”业务模块。
 * 重要函数：`normalizeQemuResult()` 负责规范化QEMU 结果；`runQemuSmoke()` 负责执行QEMU `smoke`。
 */
import { prisma } from "../../infrastructure/prisma/client.js";
import { config } from "../../config/index.js";
import { runWhitelistedMake } from "./process-runner.service.js";
import { summarizeQemuOutput } from "./qemu-output.js";

const PLACEHOLDER_QEMU_MESSAGE = "QEMU is not available in MVP1.";
const MAX_QEMU_SUMMARY_CHARS = 3000;

type RunnerResult = { status: "success" | "failed" | "timeout" | "error" | "resource_limit_exceeded" | "idle_timeout"; exitCode: number | null; output: string; limitReason?: string };

/**
 * 功能：规范化QEMU 结果。
 * 输入：`result`（RunnerResult）提供结果。
 * 输出：返回 RunnerResult，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/execution/qemu-smoke-runner.service.ts:runQemuSmoke()` 调用；内部调用 `includes()`。
 */
function normalizeQemuResult(result: RunnerResult): RunnerResult {
  if (result.status === "success" && result.output.includes(PLACEHOLDER_QEMU_MESSAGE)) {
    return {
      ...result,
      status: "failed" as const,
      output: `${result.output.trim()}

Detected placeholder Makefile target instead of a real qemu-smoke pipeline.`.trim()
    };
  }
  return result;
}

/** 只以文本/串口冒烟模式执行 `make qemu-smoke`，并持久化经过长度限制的输出。 */
/**
 * 功能：执行QEMU `smoke`。
 * 输入：`agentRunId`（string）提供Agent 运行 id。 `workspace`（{ id: string; path: string }）提供工作区。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:smokeTestAgentRun()` 调用；内部调用 `runWhitelistedMake()`、`normalizeQemuResult()`、`summarizeQemuOutput()`、`create()`。
 */
export async function runQemuSmoke(agentRunId: string, workspace: { id: string; path: string }) {
  const startedAt = new Date();
  const rawResult = await runWhitelistedMake(workspace.path, ["qemu-smoke"], config.QEMU_SMOKE_TIMEOUT_MS, { workspaceId: workspace.id, runId: agentRunId, purpose: "qemu" });
  const result = normalizeQemuResult(rawResult);
  const outputSummaryMarkdown = summarizeQemuOutput(result.output, result.status).slice(0, MAX_QEMU_SUMMARY_CHARS);
  return prisma.qemuSmokeRun.create({
    data: {
      agentRunId,
      workspaceId: workspace.id,
      status: result.status,
      exitCode: result.exitCode,
      output: result.output,
      outputSummaryMarkdown,
      startedAt,
      finishedAt: new Date()
    }
  });
}
