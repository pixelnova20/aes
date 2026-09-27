/**
 * 文件作用：实现后端“Agent 运行记录”业务模块的数据持久化与读取。
 * 模块位置：`apps/server/src/modules/agent-runs/agent-run.store.ts`，属于后端“Agent 运行记录”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import type { AgentRunStatus, AgentStepStatus } from "@prisma/client";

import { prisma } from "../../infrastructure/prisma/client.js";

export type AgentTraceInput = {
  stepName: string;
  stepStatus: AgentStepStatus;
  inputSummaryMarkdown?: string;
  outputSummaryMarkdown?: string;
  errorMarkdown?: string;
  debugMarkdown?: string;
};

export interface AgentRunStore {
  updateStatus(runId: string, status: AgentRunStatus, currentStep: string): Promise<void>;
  updateResponse(runId: string, responseMarkdown: string): Promise<void>;
  appendTrace(runId: string, trace: AgentTraceInput): Promise<void>;
  complete(runId: string, finalAnswer: string): Promise<void>;
  fail(runId: string, message: string): Promise<void>;
  cancel(runId: string, finalAnswer?: string): Promise<void>;
}

export class PrismaAgentRunStore implements AgentRunStore {
  /**
   * 功能：更新状态。
   * 输入：`runId`（string）提供运行 id。 `status`（AgentRunStatus）提供状态。 `currentStep`（string）提供current step。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:persist()` 调用；内部调用 `update()`。
   */
  async updateStatus(runId: string, status: AgentRunStatus, currentStep: string) {
    await prisma.agentRun.update({
      where: { id: runId },
      data: { status, currentStep },
    });
  }

  /**
   * 功能：更新响应。
   * 输入：`runId`（string）提供运行 id。 `responseMarkdown`（string）提供响应 Markdown 内容。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:flushPendingResponse()` 调用；内部调用 `update()`。
   */
  async updateResponse(runId: string, responseMarkdown: string) {
    await prisma.agentRun.update({
      where: { id: runId },
      data: { responseMarkdown },
    });
  }

  /**
   * 功能：追加`trace`。
   * 输入：`runId`（string）提供运行 id。 `trace`（AgentTraceInput）提供trace。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:prepareModelConfiguration()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:persist()` 调用；内部调用 `create()`。
   */
  async appendTrace(runId: string, trace: AgentTraceInput) {
    await prisma.agentTraceEvent.create({
      data: {
        agentRunId: runId,
        ...trace,
      },
    });
  }

  /**
   * 功能：处理`complete`。
   * 输入：`runId`（string）提供运行 id。 `finalAnswer`（string）提供final answer。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()` 调用；内部调用 `update()`。
   */
  async complete(runId: string, finalAnswer: string) {
    await prisma.agentRun.update({
      where: { id: runId },
      data: {
        status: "completed",
        currentStep: "completed",
        responseMarkdown: finalAnswer,
        finalAnswerMarkdown: finalAnswer,
        finishedAt: new Date(),
      },
    });
  }

  /**
   * 功能：处理`fail`。
   * 输入：`runId`（string）提供运行 id。 `message`（string）提供消息。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/ai-settings/local-model-catalog.service.test.ts 顶层流程`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()`、`scripts/check-dependencies.mjs:checkArchitectureBoundaries()`、`scripts/check-dependencies.mjs:visitModule()`、`scripts/check-dependencies.mjs 顶层流程` 调用；内部调用 `update()`。
   */
  async fail(runId: string, message: string) {
    const markdown = `## 运行失败\n\n${message}`;
    await prisma.agentRun.update({
      where: { id: runId },
      data: {
        status: "failed",
        currentStep: "failed",
        errorMessage: message,
        responseMarkdown: markdown,
        finalAnswerMarkdown: markdown,
        finishedAt: new Date(),
      },
    });
  }

  /**
   * 功能：处理`cancel`。
   * 输入：`runId`（string）提供运行 id。 `finalAnswer`提供final answer。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()` 调用；内部调用 `update()`。
   */
  async cancel(runId: string, finalAnswer = "运行已取消。") {
    await prisma.agentRun.update({
      where: { id: runId },
      data: {
        status: "cancelled",
        currentStep: "cancelled",
        responseMarkdown: finalAnswer,
        finalAnswerMarkdown: finalAnswer,
        finishedAt: new Date(),
      },
    });
  }
}
