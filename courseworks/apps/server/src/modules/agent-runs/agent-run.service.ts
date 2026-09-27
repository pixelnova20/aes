/**
 * 文件作用：实现后端“Agent 运行记录”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/agent-runs/agent-run.service.ts`，属于后端“Agent 运行记录”业务模块。
 * 重要函数：`getOwnedAgentRun()` 负责获取`owned` Agent 运行；`getAgentRunDetail()` 负责获取Agent 运行 `detail`。
 */
import { AgentRunStatus } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma/client.js";

// 这些状态表示 Agent Run 仍处于可推进阶段，停止、重置等流程都应以此为准。
export const ACTIVE_AGENT_RUN_STATUSES: AgentRunStatus[] = [
  AgentRunStatus.created,
  AgentRunStatus.context_collecting,
  AgentRunStatus.context_collected,
  AgentRunStatus.planning,
  AgentRunStatus.planned,
  AgentRunStatus.designing,
  AgentRunStatus.design_generated,
  AgentRunStatus.patch_generating,
  AgentRunStatus.patch_generated,
  AgentRunStatus.waiting_user_confirmation,
  AgentRunStatus.patch_applying,
  AgentRunStatus.patch_applied,
  AgentRunStatus.build_running,
  AgentRunStatus.build_success,
  AgentRunStatus.build_failed,
  AgentRunStatus.analyzing,
  AgentRunStatus.qemu_running,
  AgentRunStatus.qemu_success,
  AgentRunStatus.qemu_failed
];

/**
 * 功能：获取`owned` Agent 运行。
 * 输入：`agentRunId`（string）提供Agent 运行 id。 `userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:stopAgentRun()`、`apps/server/src/application/agent/agent-application.service.ts:getAgentRunTrace()`、`apps/server/src/application/agent/agent-application.service.ts:buildAgentRun()`、`apps/server/src/application/agent/agent-application.service.ts:getAgentQemuSession()`、`apps/server/src/application/agent/agent-application.service.ts:startAgentQemuSession()` 调用；内部调用 `findFirst()`。
 */
export async function getOwnedAgentRun(agentRunId: string, userId: string) {
  const run = await prisma.agentRun.findFirst({ where: { id: agentRunId, userId }, include: { workspace: true } });
  if (!run) throw new Error("Agent 运行记录不存在。");
  return run;
}

/** 获取 Agent Run 详情，含 trace/patches/runner/qemu 等关联数据。从旧 orchestrator 迁移至此。 */
/**
 * 功能：获取Agent 运行 `detail`。
 * 输入：`agentRunId`（string）提供Agent 运行 id。 `userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `findFirst()`。
 */
export async function getAgentRunDetail(agentRunId: string, userId: string) {
  const run = await prisma.agentRun.findFirst({
    where: { id: agentRunId, userId },
    include: {
      courseTaskSession: true,
      courseSubtask: { include: { files: { orderBy: { updatedAt: "desc" }, take: 8 } } },
      traceEvents: { orderBy: { createdAt: "asc" } },
      patchPlans: { orderBy: { createdAt: "desc" }, take: 1 },
      checkpoints: { orderBy: { createdAt: "desc" } },
      buildRuns: { orderBy: { createdAt: "desc" }, take: 1 },
      qemuSmokeRuns: { orderBy: { createdAt: "desc" }, take: 1 }
    }
  });
  if (!run) throw new Error("Agent 运行记录不存在。");
  return run;
}
