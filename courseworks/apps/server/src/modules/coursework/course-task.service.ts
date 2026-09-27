/**
 * 文件作用：实现后端“长期课程任务”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/coursework/course-task.service.ts`，属于后端“长期课程任务”业务模块。
 * 重要函数：`normalizePrompt()` 负责规范化提示词；`truncate()` 负责处理`truncate`；`compactBlock()` 负责压缩`block`；`stripMarkdownHeading()` 负责处理`strip` Markdown 内容 `heading`；`workspaceHandoffRoot()` 负责处理工作区 `handoff` 根目录；`subtaskSummaryPath()` 负责处理`subtask` 摘要 路径；`sessionSummaryPath()` 负责处理会话 摘要 路径；`formatFileList()` 负责格式化文件 `list`。
 */
import fs from "node:fs/promises";
import path from "node:path";

import { ExecutionStatus, type CourseSubtask, type CourseTaskSession, type Prisma, type Workspace } from "@prisma/client";

import { prisma } from "../../infrastructure/prisma/client.js";

export type AgentRunModeInput = "continue_subtask" | "new_subtask" | "reset_context_then_run";

type SessionContext = {
  session: CourseTaskSession;
  subtask: CourseSubtask;
  runMode: AgentRunModeInput;
  createdNewSubtask: boolean;
};

const DEFAULT_SESSION_TITLE = "Current project task";
const HANDOFF_DIRECTORY = [".local", "state", "courseworks", "course-task"];
const MAX_GOAL_CHARS = 1_200;
const MAX_RESULT_CHARS = 1_800;
const MAX_VALIDATION_CHARS = 1_200;
const MAX_SESSION_SUMMARY_CHARS = 10_000;

/**
 * 功能：规范化提示词。
 * 输入：`value`（string）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/conversations/session-store.ts:createSessionEntry()`、`apps/server/src/modules/coursework/course-task.service.ts:isInspectionOnlyPrompt()`、`apps/server/src/modules/coursework/course-task.service.ts:isFollowUpPrompt()` 调用；内部调用 `replace()`。
 */
function normalizePrompt(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * 功能：处理`truncate`。
 * 输入：`value`（string）提供value。 `max`提供max。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:safeJson()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:buildFallbackAnswer()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:persist()`、`apps/server/src/modules/conversations/session-store.ts:deriveSessionTitle()`、`apps/server/src/modules/conversations/session-store.ts:createSessionEntry()` 调用。
 */
function truncate(value: string, max = 120) {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

/**
 * 功能：压缩`block`。
 * 输入：`value`（string | null | undefined）提供value。 `max`（number）提供max。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coursework/course-task.service.ts:recordCourseTaskRunOutcome()` 调用；内部调用 `replace()`。
 */
function compactBlock(value: string | null | undefined, max: number) {
  const normalized = (value ?? "")
    .trim()
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
  if (!normalized) return "";
  return normalized.length > max ? `${normalized.slice(0, max)}\n[truncated]` : normalized;
}

/**
 * 功能：处理`strip` Markdown 内容 `heading`。
 * 输入：`value`（string | null | undefined）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coursework/course-task.service.ts:recordCourseTaskRunOutcome()` 调用；内部调用 `replace()`。
 */
function stripMarkdownHeading(value: string | null | undefined) {
  return (value ?? "").replace(/^#{1,3}\s+[^\n]+\n*/i, "").trim();
}

/**
 * 功能：处理工作区 `handoff` 根目录。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coursework/course-task.service.ts:subtaskSummaryPath()`、`apps/server/src/modules/coursework/course-task.service.ts:sessionSummaryPath()`、`apps/server/src/modules/coursework/course-task.service.ts:recordCourseTaskRunOutcome()` 调用；内部调用 `dirname()`、`resolve()`。
 */
function workspaceHandoffRoot(workspacePath: string) {
  return path.join(path.dirname(path.resolve(workspacePath)), ...HANDOFF_DIRECTORY);
}

/**
 * 功能：处理`subtask` 摘要 路径。
 * 输入：`workspacePath`（string）提供工作区 路径。 `subtaskId`（string）提供subtask id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coursework/course-task.service.ts:recordCourseTaskRunOutcome()` 调用；内部调用 `workspaceHandoffRoot()`。
 */
function subtaskSummaryPath(workspacePath: string, subtaskId: string) {
  return path.join(workspaceHandoffRoot(workspacePath), "subtasks", `${subtaskId}.md`);
}

/**
 * 功能：处理会话 摘要 路径。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coursework/course-task.service.ts:recordCourseTaskRunOutcome()` 调用；内部调用 `workspaceHandoffRoot()`。
 */
function sessionSummaryPath(workspacePath: string) {
  return path.join(workspaceHandoffRoot(workspacePath), "session-summary.md");
}

/**
 * 功能：格式化文件 `list`。
 * 输入：`files`（string[] | undefined）提供文件列表。 `max`提供max。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coursework/course-task.service.ts:recordCourseTaskRunOutcome()` 调用。
 */
function formatFileList(files: string[] | undefined, max = 12) {
  const unique = [...new Set(files ?? [])].slice(0, max);
  return unique.length ? unique.map((file) => `- \`${file}\``).join("\n") : "- No modified files recorded.";
}

/**
 * 功能：处理状态 `label`。
 * 输入：`status`（string | null | undefined）提供状态。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coursework/course-task.service.ts:recordCourseTaskRunOutcome()` 调用。
 */
function statusLabel(status: string | null | undefined) {
  if (!status) return "unknown";
  if (status === "done" || status === "completed") return "completed";
  return status;
}

/**
 * 功能：推导`subtask` `title`。
 * 输入：`prompt`（string）提供提示词。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coursework/course-task.service.ts:createSubtask()`、`apps/server/src/modules/coursework/course-task.service.ts:resolveCourseTaskContext()` 调用；内部调用 `find()`、`split()`、`truncate()`。
 */
function deriveSubtaskTitle(prompt: string) {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return truncate(firstLine || "Untitled subtask");
}

/**
 * 功能：判断是否为`inspection` `only` 提示词。
 * 输入：`prompt`（string）提供提示词。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `normalizePrompt()`、`test()`。
 */
export function isInspectionOnlyPrompt(prompt: string) {
  const normalized = normalizePrompt(prompt);
  const asksForImplementation = /(实现|修改|创建|新增|编写|修复|完成|支持|构建|编译|运行|设计并实现|开发|加上|补齐|移动|删除|重构|优化)/i.test(normalized);
  const asksForInspection = /(阅读|查看|了解|检查|分析|解释|总结|梳理|看看|确认|审查|排查|先阅读|先看|阅读.*文件|检查.*环境)/i.test(normalized);
  return asksForInspection && !asksForImplementation;
}

/**
 * 功能：判断是否为`follow` `up` 提示词。
 * 输入：`prompt`（string）提供提示词。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/coursework/course-task.service.ts:resolveCourseTaskContext()` 调用；内部调用 `normalizePrompt()`、`test()`。
 */
function isFollowUpPrompt(prompt: string) {
  const normalized = normalizePrompt(prompt);
  return /^(你测试了吗|测试了吗|上一步成功了吗|你完成了吗|你做了测试吗|为什么|怎么|那上一步的上一步呢|请解释|继续|继续改|修一下|修复一下|再试一次|接着|沿着上一步)/i.test(normalized);
}

/**
 * 功能：确保课程 课程任务 会话。
 * 输入：`userId`（string）提供用户 id。 `workspace`（Workspace）提供工作区。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coursework/course-task.service.ts:resolveCourseTaskContext()` 调用；内部调用 `findFirst()`、`create()`。
 */
async function ensureCourseTaskSession(userId: string, workspace: Workspace) {
  const existing = await prisma.courseTaskSession.findFirst({
    where: { userId, workspaceId: workspace.id, status: "active" },
    orderBy: { updatedAt: "desc" }
  });
  if (existing) return existing;
  return prisma.courseTaskSession.create({
    data: {
      userId,
      workspaceId: workspace.id,
      title: DEFAULT_SESSION_TITLE,
      status: "active"
    }
  });
}

/**
 * 功能：创建`subtask`。
 * 输入：`sessionId`（string）提供会话 id。 `prompt`（string）提供提示词。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coursework/course-task.service.ts:resolveCourseTaskContext()` 调用；内部调用 `create()`、`deriveSubtaskTitle()`。
 */
async function createSubtask(sessionId: string, prompt: string) {
  return prisma.courseSubtask.create({
    data: {
      courseTaskSessionId: sessionId,
      title: deriveSubtaskTitle(prompt),
      goalMarkdown: prompt,
      latestUserIntent: prompt,
      status: "active"
    }
  });
}

/**
 * 功能：重置课程 课程任务 上下文。
 * 输入：`userId`（string）提供用户 id。 `workspace`（Workspace）提供工作区。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:startNewAgentChat()` 调用；内部调用 `updateMany()`。
 */
export async function resetCourseTaskContext(userId: string, workspace: Workspace) {
  // /new 之后不应再把旧课程任务摘要注入新会话，因此这里把旧 active session 收口，
  // 后续第一次新 prompt 会自然创建一个新的 course task session。
  await prisma.courseTaskSession.updateMany({
    where: { userId, workspaceId: workspace.id, status: "active" },
    data: {
      status: "completed",
      updatedAt: new Date()
    }
  });
}

/**
 * 功能：解析并确定课程 课程任务 上下文。
 * 输入：`userId`（string）提供用户 id。 `workspace`（Workspace）提供工作区。 `prompt`（string）提供提示词。 `requestedRunMode`（AgentRunModeInput）提供requested 运行 mode。
 * 输出：返回 Promise<SessionContext>，供调用方继续处理。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `ensureCourseTaskSession()`、`findFirst()`、`isFollowUpPrompt()`、`createSubtask()`、`update()`、`deriveSubtaskTitle()`。
 */
export async function resolveCourseTaskContext(userId: string, workspace: Workspace, prompt: string, requestedRunMode?: AgentRunModeInput): Promise<SessionContext> {
  const runMode = requestedRunMode ?? "continue_subtask";
  const session = await ensureCourseTaskSession(userId, workspace);
  const latestSubtask = await prisma.courseSubtask.findFirst({
    where: { courseTaskSessionId: session.id },
    orderBy: { updatedAt: "desc" }
  });

  let subtask = latestSubtask;
  const shouldCreateNewSubtask = runMode === "new_subtask" || !latestSubtask || !isFollowUpPrompt(prompt);
  if (shouldCreateNewSubtask) {
    subtask = await createSubtask(session.id, prompt);
  } else if (subtask) {
    subtask = await prisma.courseSubtask.update({
      where: { id: subtask.id },
      data: {
        latestUserIntent: prompt,
        title: subtask.title || deriveSubtaskTitle(prompt)
      }
    });
  }

  if (!subtask) {
    subtask = await createSubtask(session.id, prompt);
  }

  await prisma.courseTaskSession.update({
    where: { id: session.id },
    data: {
      currentSubtaskId: subtask.id,
      summaryMarkdown: session.summaryMarkdown ?? "The session has started.",
      updatedAt: new Date()
    }
  });

  return { session, subtask, runMode, createdNewSubtask: shouldCreateNewSubtask };
}

/**
 * 功能：合并状态。
 * 输入：`current`（ExecutionStatus | null | undefined）提供current。 `next`（ExecutionStatus | null | undefined）提供next。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coursework/course-task.service.ts:recordCourseTaskRunOutcome()` 调用。
 */
function mergeStatus(current: ExecutionStatus | null | undefined, next: ExecutionStatus | null | undefined) {
  return next ?? current ?? null;
}

/**
 * 功能：记录课程 课程任务 运行 `outcome`。
 * 输入：`args`（{ runId: string; courseTaskSessionId?: string | null; courseSubtaskId?: string | null; chatSessionId?: string | null; ru）提供args。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:buildAgentRun()`、`apps/server/src/application/agent/agent-application.service.ts:smokeTestAgentRun()` 调用；内部调用 `compactBlock()`、`stripMarkdownHeading()`、`formatFileList()`、`$transaction()`、`findUnique()`、`update()`。
 */
export async function recordCourseTaskRunOutcome(args: {
  runId: string;
  courseTaskSessionId?: string | null;
  courseSubtaskId?: string | null;
  chatSessionId?: string | null;
  runStatus?: "completed" | "failed" | "cancelled";
  prompt: string;
  finalAnswerMarkdown?: string | null;
  modifiedFiles?: string[];
  buildStatus?: ExecutionStatus | null;
  qemuStatus?: ExecutionStatus | null;
  validationSummary?: string | null;
}) {
  const { courseTaskSessionId, courseSubtaskId } = args;
  if (!courseTaskSessionId || !courseSubtaskId) return;

  const compactResult = compactBlock(stripMarkdownHeading(args.finalAnswerMarkdown) || "No final answer recorded.", MAX_RESULT_CHARS);
  const compactValidation = compactBlock(args.validationSummary, MAX_VALIDATION_CHARS);
  const subtaskSummary = [
    "# Subtask Handoff",
    "",
    `- Run: \`${args.runId}\``,
    `- Agent session: ${args.chatSessionId ? `\`${args.chatSessionId}\`` : "not recorded"}`,
    `- Status: ${args.runStatus ?? "unknown"}`,
    "",
    "## Goal",
    compactBlock(args.prompt, MAX_GOAL_CHARS),
    "",
    "## Outcome",
    compactResult,
    "",
    "## Validation",
    compactValidation || "- No validation summary recorded.",
    "",
    "## Modified Files",
    formatFileList(args.modifiedFiles)
  ].join("\n");

  const handoff = await prisma.$transaction(async (tx) => {
    const sessionWithWorkspace = await tx.courseTaskSession.findUnique({
      where: { id: courseTaskSessionId },
      include: { workspace: true }
    });

    await tx.courseTaskSession.update({
      where: { id: courseTaskSessionId },
      data: {
        currentSubtaskId: courseSubtaskId,
        lastRunId: args.runId
      }
    });

    const existing = await tx.courseSubtask.findUnique({ where: { id: courseSubtaskId } });
    if (!existing) return;

    await tx.courseSubtask.update({
      where: { id: courseSubtaskId },
      data: {
        latestUserIntent: args.prompt,
        goalMarkdown: existing.goalMarkdown || args.prompt,
        status: args.runStatus === "completed" ? "done" : args.runStatus === "failed" ? "blocked" : existing.status,
        lastRunId: args.runId,
        lastValidationSummary: compactValidation || existing.lastValidationSummary,
        lastBuildStatus: mergeStatus(existing.lastBuildStatus, args.buildStatus),
        lastQemuStatus: mergeStatus(existing.lastQemuStatus, args.qemuStatus)
      }
    });

    if (args.modifiedFiles?.length) {
      await tx.courseSubtaskFile.deleteMany({
        where: { courseSubtaskId, kind: "modified" }
      });
      await tx.courseSubtaskFile.createMany({
        data: args.modifiedFiles.map((file) => ({
          courseSubtaskId,
          path: file,
          kind: "modified"
        }))
      });
    }

    await tx.agentRun.update({
      where: { id: args.runId },
      data: { taskSummary: subtaskSummary }
    }).catch(() => undefined);

    const subtasks = await tx.courseSubtask.findMany({
      where: { courseTaskSessionId },
      orderBy: { createdAt: "asc" },
      include: {
        files: {
          where: { kind: "modified" },
          orderBy: { updatedAt: "desc" },
          take: 8
        }
      }
    });
    const sessionSummary = [
      "# Project Task Handoff",
      "",
      "This is a compact platform-maintained summary for continuing the current long-running project task. Full transcripts remain archived in hidden workspace state and AgentRun records.",
      "",
      "## Subtasks",
      ...subtasks.slice(-8).flatMap((subtask, index) => [
        "",
        `### ${index + 1}. ${subtask.title}`,
        `- Status: ${statusLabel(subtask.status)}`,
        `- Last run: ${subtask.lastRunId ? `\`${subtask.lastRunId}\`` : "none"}`,
        `- Goal: ${compactBlock(subtask.goalMarkdown ?? subtask.latestUserIntent ?? "", 500).replace(/\n/g, " ") || "No goal recorded."}`,
        `- Validation: ${compactBlock(subtask.lastValidationSummary, 500).replace(/\n/g, " ") || "No validation recorded."}`,
        subtask.files.length ? `- Modified files: ${subtask.files.map((file) => `\`${file.path}\``).join(", ")}` : "- Modified files: none recorded"
      ])
    ].join("\n").slice(0, MAX_SESSION_SUMMARY_CHARS);

    await tx.courseTaskSession.update({
      where: { id: courseTaskSessionId },
      data: { summaryMarkdown: sessionSummary }
    });

    return sessionWithWorkspace?.workspace.path
      ? { workspacePath: sessionWithWorkspace.workspace.path, sessionSummary }
      : null;
  });

  if (handoff) {
    const root = workspaceHandoffRoot(handoff.workspacePath);
    await fs.mkdir(path.join(root, "subtasks"), { recursive: true, mode: 0o700 });
    await Promise.all([
      fs.writeFile(sessionSummaryPath(handoff.workspacePath), `${handoff.sessionSummary}\n`, { mode: 0o600 }),
      fs.writeFile(subtaskSummaryPath(handoff.workspacePath, courseSubtaskId), `${subtaskSummary}\n`, { mode: 0o600 })
    ]);
  }
}

/**
 * 功能：获取课程 课程任务 `snapshot`。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `findFirst()`。
 */
export async function getCourseTaskSnapshot(userId: string) {
  return prisma.courseTaskSession.findFirst({
    where: { userId, status: "active" },
    orderBy: { updatedAt: "desc" },
    include: {
      subtasks: {
        orderBy: { updatedAt: "desc" },
        take: 1,
        include: {
          files: {
            orderBy: { updatedAt: "desc" },
            take: 8
          }
        }
      }
    }
  });
}

export type CourseTaskSnapshot = Prisma.PromiseReturnType<typeof getCourseTaskSnapshot>;
