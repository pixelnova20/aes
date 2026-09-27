/**
 * 文件作用：实现后端“Agent 运行记录”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/agent-runs/agent-trace.service.ts`，属于后端“Agent 运行记录”业务模块。
 * 重要函数：`addTrace()` 负责处理`add` `trace`。
 */
import type { AgentStepStatus } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma/client.js";

/**
 * 功能：处理`add` `trace`。
 * 输入：`agentRunId`（string）提供Agent 运行 id。 `stepName`（string）提供step name。 `stepStatus`（AgentStepStatus）提供step 状态。 `data`（{ inputSummaryMarkdown?: string; outputSummaryMarkdown?: string; errorMarkdown?: string; debugMarkdown?: string }）提供data。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:applyAgentPatchPlan()`、`apps/server/src/application/agent/agent-application.service.ts:buildAgentRun()`、`apps/server/src/application/agent/agent-application.service.ts:smokeTestAgentRun()`、`apps/server/src/application/agent/agent-application.service.ts:analyzeAgentBuild()`、`apps/server/src/application/agent/agent-application.service.ts:analyzeAgentQemuRun()` 调用；内部调用 `create()`。
 */
export async function addTrace(agentRunId: string, stepName: string, stepStatus: AgentStepStatus, data: { inputSummaryMarkdown?: string; outputSummaryMarkdown?: string; errorMarkdown?: string; debugMarkdown?: string } = {}) {
  return prisma.agentTraceEvent.create({ data: { agentRunId, stepName, stepStatus, ...data } });
}
