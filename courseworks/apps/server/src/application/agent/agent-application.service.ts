/**
 * 文件作用：编排后端“Agent 用例”应用编排层用例及其跨模块调用。
 * 模块位置：`apps/server/src/application/agent/agent-application.service.ts`，属于后端“Agent 用例”应用编排层。
 * 重要函数：`refreshEvaluationHistorySafely()` 负责安全刷新学生课程评价历史，并把刷新失败降级为日志；`handleTools()` 负责生成 `/tools` 命令对应的工具清单；`handleContext()` 负责生成 `/context` 命令对应的会话与运行摘要；`handleNew()` 负责生成 `/new` 命令的确认响应；`handleCompact()` 负责生成 `/compact` 命令的压缩提示；`knownCommands()` 负责汇总当前可用的聊天命令；`submitAgentPrompt()` 负责接收用户提示词并编排会话、附件、课程任务、Agent Run 与 Pi runtime；`resolveAgentContextUsage()` 负责计算 Agent 会话上下文窗口占用。
 */
import { readFile as readBinaryFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { prisma } from "../../infrastructure/prisma/client.js";
import { logAutoReply, logInput, logSystem } from "../../infrastructure/logging/logger.js";
import { getTeacherReviewAgentContext } from "../teacher/teacher-review-application.service.js";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  AGENT_STEP_NAMES,
  addTrace,
  getAgentRunDetail,
  getOwnedAgentRun,
} from "../../modules/agent-runs/index.js";
import {
  consumeStagedUploadsForSession,
  archiveWorkspaceUploads,
  getConsumedArtifact,
  getGeneratedArtifact,
  stagedUploadContainerPath,
  retainArtifactsForSessions,
} from "../../modules/artifacts/index.js";
import {
  analyzeBuildError,
  analyzeQemuOutput,
  type AgentImageInput,
  buildOpenFilesContext,
  codingAgentRuntime,
  readPiSessionContextUsage,
  retainPiSessions,
} from "../../modules/coding-agent/index.js";
import {
  acquireUserAiRequestSlot,
  AiDailyTokenQuotaError,
  beginClassAiAgentQuota,
  normalizeReasoningEffortForModel,
  resolveContextWindowTokens,
  resolveModelCapabilities,
  resolveSelectedAiProviderProfile,
} from "../../modules/ai-settings/index.js";
import {
  createNewChatSession,
  ensureActiveChatSession,
  getActiveChatSessionSnapshot,
  recordAttachmentConsumption,
  recordChatSessionEvent,
  retainChatSessions,
} from "../../modules/conversations/index.js";
import {
  getCourseTaskSnapshot,
  recordCourseTaskRunOutcome,
  resetCourseTaskContext,
} from "../../modules/coursework/index.js";
import {
  archiveActiveEvaluationSession,
  recordWorkspaceActivityEvent,
  refreshEvaluationHistory,
  retainLatestPastSessionArchive,
} from "../../modules/evaluation-history/index.js";
import {
  getQemuSessionSnapshot,
  resetWorkspaceAgentRuntime,
  runMakeBuild,
  runQemuSmoke,
  sendQemuSessionInput,
  startQemuSession,
  stopQemuSession,
} from "../../modules/execution/index.js";
import {
  applyWorkspacePatch,
  assertWorkspaceExecutionAllowed,
  clearWorkspaceContents,
  createCheckpoint,
  getReadyWorkspaceForUser,
  restoreCheckpoint,
} from "../../modules/workspaces/index.js";
import { listChatCommands, resolveTextCommand } from "./commands/commands-registry.js";
import type {
  CommandHandlerContext,
  CommandResult,
} from "./commands/commands-registry.types.js";

export type SubmitAgentPromptInput = {
  userId: string;
  email: string;
  prompt: string;
  mode?: AgentMode;
  openFiles?: string[];
  attachmentIds?: string[];
  selection?: {
    filePath: string;
    text: string;
    startLine: number;
    endLine: number;
  };
};

export type AgentMode = "work" | "review";

export function buildTeacherReviewSystemPrompt(readableStudentCount: number, totalStudentCount: number) {
  return [
    "You are the Courseworks agent for a teacher who is currently in review mode.",
    `There are ${readableStudentCount} readable student workspaces in the current audit directory (${totalStudentCount} enrolled student accounts in total).`,
    "Each top-level student directory is a read-only view of that student's original Courseworks workspace; match.md maps directory names to students.",
    "Every student's .eva_history directory records all of that student's Agent Runs and may be used to review the development process.",
    "Use the read-only ls, grep, and read tools to inspect one student, compare several students, or perform a batch review as requested.",
    "Never modify, delete, move, copy, or generate files in a student workspace. Do not claim that you edited files, ran builds, or ran QEMU.",
    "Do not access .git, .env, .checkpoints, or node_modules. Read only the files needed for the teacher's request.",
    "Prefer workspace-relative paths. Never use host filesystem paths in tool calls.",
    "Before each meaningful tool batch, briefly tell the teacher what you are checking. Never reveal private chain-of-thought.",
    "Base conclusions on concrete files and Agent Run records, identify the corresponding student, and distinguish evidence from inference.",
    "Reply in Chinese when the teacher writes in Chinese, and finish with concise Markdown.",
  ].join("\n");
}

async function resolveAgentWorkspaceContext(userId: string, mode: AgentMode = "work") {
  const workspace = await getReadyWorkspaceForUser(userId);
  if (mode === "work") {
    return {
      mode,
      workspace,
      cwd: workspace.path,
      owner: { userId, workspaceId: workspace.id },
      systemPrompt: undefined,
      readableWorkspaceRoots: undefined,
    };
  }

  const review = await getTeacherReviewAgentContext(userId);
  return {
    mode,
    workspace,
    cwd: review.auditPath,
    owner: {
      courseId: `courseworks-review:${review.classCode}`,
      userId,
      workspaceId: workspace.id,
    },
    systemPrompt: buildTeacherReviewSystemPrompt(
      review.readableStudentCount,
      review.totalStudentCount,
    ),
    readableWorkspaceRoots: review.readableWorkspaceRoots,
  };
}

/**
 * 功能：安全刷新学生课程评价历史，并把刷新失败降级为日志。
 * 输入：`workspacePath`（string）提供工作区 路径。 `userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:submitAgentPrompt()`、`apps/server/src/application/agent/agent-application.service.ts:startNewAgentChat()`、`apps/server/src/application/agent/agent-application.service.ts:buildAgentRun()`、`apps/server/src/application/agent/agent-application.service.ts:smokeTestAgentRun()` 调用；内部调用 `refreshEvaluationHistory()`、`logSystem()`。
 */
async function refreshEvaluationHistorySafely(workspacePath: string, userId: string) {
  try {
    const result = await refreshEvaluationHistory({ workspacePath, userId });
    logSystem(
      `Evaluation history refreshed: ${result.runCount} runs, ${result.conversationCount} conversations.`,
    );
  } catch (error) {
    logSystem(
      `Evaluation history refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 功能：生成 `/tools` 命令对应的工具清单。
 * 输入：`_context`（CommandHandlerContext）提供上下文。
 * 输出：返回 Promise<CommandResult>，供调用方继续处理。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `listTools()`。
 */
async function handleTools(context: CommandHandlerContext): Promise<CommandResult> {
  const tools = codingAgentRuntime.listTools(context.mode);
  const toolList = tools.length
    ? tools.map((tool) => `- **\`${tool.name}\`** - ${tool.description}`).join("\n")
    : "No tools registered.";
  return {
    type: "command",
    key: "tools",
    markdown: `## \`/tools\` - ${tools.length} tools available\n\n${toolList}`,
    sideEffect: "none",
  };
}

/**
 * 功能：生成 `/context` 命令对应的会话与运行摘要。
 * 输入：`context`（CommandHandlerContext）提供上下文。
 * 输出：返回 Promise<CommandResult>，供调用方继续处理。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `findUnique()`、`findMany()`、`toLocaleString()`。
 */
async function handleContext(context: CommandHandlerContext): Promise<CommandResult> {
  const workspace = await prisma.workspace.findUnique({
    where: { userId: context.userId },
    select: { workspaceUuid: true, status: true, createdAt: true },
  });
  const recentRuns = await prisma.agentRun.findMany({
    where: { userId: context.userId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, prompt: true, status: true, createdAt: true },
  });
  const lines = [
    "## `/context` - Session Overview",
    "",
    "| Item | Value |",
    "|------|-------|",
    `| Workspace | ${workspace?.workspaceUuid?.slice(0, 8) ?? "N/A"} |`,
    `| Status | ${workspace?.status ?? "N/A"} |`,
    "",
    "### Recent Runs",
    "",
  ];
  if (recentRuns.length) {
    lines.push("| Run ID | Prompt | Status | Created |", "|--------|--------|--------|---------|");
    for (const run of recentRuns) {
      lines.push(
        `| ${run.id.slice(0, 8)} | ${run.prompt.slice(0, 40)} | ${run.status} | ${run.createdAt.toLocaleString()} |`,
      );
    }
  } else {
    lines.push("No runs yet.");
  }
  return {
    type: "command",
    key: "context",
    markdown: lines.join("\n"),
    sideEffect: "none",
  };
}

/**
 * 功能：生成 `/new` 命令的确认响应。
 * 输入：无显式输入参数。
 * 输出：返回 CommandResult，供调用方继续处理。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用。
 */
function handleNew(): CommandResult {
  return {
    type: "command",
    key: "new",
    markdown: "## `/new` - Reset Session\n\n请确认是否清空工作区，并重新开始工程。",
    sideEffect: "reset_session",
  };
}

/**
 * 功能：生成 `/compact` 命令的压缩提示。
 * 输入：无显式输入参数。
 * 输出：返回 CommandResult，供调用方继续处理。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用。
 */
function handleCompact(): CommandResult {
  return {
    type: "command",
    key: "compact",
    markdown: "## `/compact` - Compacting...\n\n正在压缩会话历史...",
    sideEffect: "none",
  };
}

const COMMAND_HANDLERS: Record<
  string,
  (context: CommandHandlerContext) => Promise<CommandResult> | CommandResult
> = {
  tools: handleTools,
  context: handleContext,
  new: handleNew,
  compact: handleCompact,
};

/**
 * 功能：汇总当前可用的聊天命令。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:submitAgentPrompt()` 调用；内部调用 `listChatCommands()`。
 */
function knownCommands() {
  const lines = ["## Available Commands", ""];
  for (const command of listChatCommands()) {
    lines.push(`- **\`${command.textAliases[0]}\`** - ${command.description}`);
  }
  return lines.join("\n");
}

/**
 * 功能：接收用户提示词并编排会话、附件、课程任务、Agent Run 与 Pi runtime。
 * 输入：`input`（SubmitAgentPromptInput）提供当前操作所需的结构化输入。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspaceForUser()`、`logInput()`、`resolveTextCommand()`、`handler()`、`knownCommands()`、`logAutoReply()`。
 */
export async function submitAgentPrompt(input: SubmitAgentPromptInput) {
  const agentContext = await resolveAgentWorkspaceContext(input.userId, input.mode);
  const { workspace } = agentContext;
  logInput(
    input.email,
    input.prompt,
    input.openFiles?.length ?? 0,
    input.attachmentIds?.length ?? 0,
  );

  const resolvedCommand = resolveTextCommand(input.prompt);
  if (resolvedCommand) {
    const handler = COMMAND_HANDLERS[resolvedCommand.command.key];
    const command = handler
      ? await handler({
          userId: input.userId,
          workspacePath: workspace.path,
          mode: agentContext.mode,
          args: resolvedCommand.args,
        })
      : {
          type: "command" as const,
          key: resolvedCommand.command.key,
          markdown: knownCommands(),
          sideEffect: "none" as const,
        };
    logAutoReply(input.email, "command", command.key);
    return { type: "command" as const, command };
  }

  await assertWorkspaceExecutionAllowed(workspace.path);

  const settings = await resolveSelectedAiProviderProfile(input.userId);
  if (!settings) throw new Error("请先在服务门户中配置 AI Provider。");
  const contextWindowTokens = await resolveContextWindowTokens(
    settings.model,
    settings.contextWindowTokens ?? undefined,
    prisma,
    settings.baseUrl,
  );
  const modelCapabilities = resolveModelCapabilities({
    model: settings.model,
    baseUrl: settings.baseUrl,
    contextWindowTokens,
  });
  logAutoReply(input.email, "agent-dispatch", `model=${settings.model}`);

  const chatSession = await ensureActiveChatSession(
    workspace.path,
    agentContext.cwd,
    input.prompt,
    agentContext.owner,
  );

  const previousRun = await prisma.agentRun.findFirst({
    where: {
      workspaceId: workspace.id,
      sessionId: chatSession.sessionId,
      runSequence: { not: null },
    },
    orderBy: { runSequence: "desc" },
    select: { runSequence: true },
  });
  const runSequence = (previousRun?.runSequence ?? 0) + 1;
  const run = await prisma.agentRun.create({
    data: {
      userId: input.userId,
      workspaceId: workspace.id,
      sessionId: chatSession.sessionId,
      runSequence,
      modelName: settings.model,
      prompt: input.prompt,
      status: "created",
      currentStep: "agent_loop_start",
    },
  });

  let mediaNote = "";
  let images: AgentImageInput[] = [];
  if (input.attachmentIds?.length) {
    try {
      const resolvedUploads = await consumeStagedUploadsForSession({
        workspacePath: workspace.path,
        session: chatSession,
        runId: run.id,
        uploadIds: input.attachmentIds,
      });
      await recordAttachmentConsumption(
        workspace.path,
        chatSession.sessionId,
        undefined,
        run.id,
        resolvedUploads.uploads,
        resolvedUploads.artifacts,
      );
      const attachmentMeta: string[] = [];
      mediaNote = resolvedUploads.uploads.map((upload) => {
        const kind = upload.mimeType.startsWith("text/")
          || /\.(c|h|cpp|hpp|s|S|txt|md|json|yaml|yml|toml|csv|ts|tsx|js|jsx|py|java|rs|go|sh)$/i.test(upload.originalName)
          ? "text"
          : upload.mimeType || "binary";
        attachmentMeta.push(`${upload.originalName} (${kind}, ${upload.sizeBytes}B)`);
        return `[media attached: ${stagedUploadContainerPath(upload)}]`;
      }).join("\n");
      if (modelCapabilities.supportsImages) {
        images = await Promise.all(resolvedUploads.uploads
          .filter((upload) => upload.mimeType.startsWith("image/"))
          .map(async (upload) => ({
            data: (await readBinaryFile(upload.absolutePath)).toString("base64"),
            mimeType: upload.mimeType,
          })));
      }
      logSystem(`Consumed ${resolvedUploads.uploads.length} uploads: ${attachmentMeta.join("; ")}`);
    } catch (error) {
      logSystem(`Attachment consumption failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const openFilesContext = agentContext.mode === "review"
    ? ""
    : buildOpenFilesContext(workspace.path, input.openFiles ?? []);
  let selectionSnippet = "";
  if (input.selection?.text) {
    const range = input.selection.startLine === input.selection.endLine
      ? `line ${input.selection.startLine}`
      : `lines ${input.selection.startLine}-${input.selection.endLine}`;
    selectionSnippet = `[selected text from ${input.selection.filePath}:${range}]\n\`\`\`\n${input.selection.text.slice(0, 6000)}\n\`\`\``;
  }
  const userContent = [input.prompt, selectionSnippet, mediaNote, openFilesContext]
    .filter(Boolean)
    .join("\n\n");
  logSystem(`Agent input assembled (${userContent.length} chars).`);

  let releaseAiSlot: (() => void) | undefined;
  let tokenQuota: Awaited<ReturnType<typeof beginClassAiAgentQuota>> | undefined;
  try {
    tokenQuota = await beginClassAiAgentQuota(input.userId, settings);
    releaseAiSlot = acquireUserAiRequestSlot(input.userId);
  } catch (error) {
    await tokenQuota?.release();
    await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        currentStep: error instanceof AiDailyTokenQuotaError
          ? "ai_daily_token_quota"
          : "ai_concurrency_limit",
        finishedAt: new Date(),
      },
    });
    throw error;
  }
  if (!tokenQuota) throw new Error("AI Token 配额初始化失败。");

  void codingAgentRuntime.run({
    runId: run.id,
    userId: input.userId,
    workspaceId: workspace.id,
    workspacePath: workspace.path,
    cwd: agentContext.cwd,
    prompt: userContent,
    ...(images.length ? { images } : {}),
    aiSettings: {
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      profileName: settings.name,
      profileSource: settings.source,
      temperature: settings.temperature ?? undefined,
      contextWindowTokens,
      reasoningEffort: normalizeReasoningEffortForModel(
        settings.model,
        settings.reasoningEffort,
        settings.baseUrl,
      ),
    },
    chatSession,
    mode: agentContext.mode,
    systemPrompt: agentContext.systemPrompt,
    readableWorkspaceRoots: agentContext.readableWorkspaceRoots,
    email: input.email,
    ...(agentContext.mode === "work" ? {
      onMutation: (mutation) => recordWorkspaceActivityEvent({
        workspaceId: workspace.id,
        actorUserId: input.userId,
        sessionId: chatSession.sessionId,
        runId: run.id,
        mutation,
      }),
    } : {}),
    onTokenUsage: tokenQuota.consume,
  }).catch((error) => {
    console.error("[pi-agent]", error instanceof Error ? error.message : error);
  }).finally(async () => {
    releaseAiSlot?.();
    try {
      await tokenQuota.release();
    } catch (error) {
      console.error("[pi-agent-quota-release]", error instanceof Error ? error.message : error);
    }
  }).then(() => agentContext.mode === "work"
    ? refreshEvaluationHistorySafely(workspace.path, input.userId)
    : undefined);

  return { type: "run" as const, run };
}

export { getCourseTaskSnapshot as getAgentCourseTaskSnapshot };

/**
 * 功能：计算 Agent 会话上下文窗口占用。
 * 输入：`userId`（string）提供用户 id。 `workspacePath`（string）提供工作区 路径。 `sessionId`（string）提供会话 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:getAgentChatSnapshot()`、`apps/server/src/application/agent/agent-application.service.ts:getAgentChatContextUsage()`、`apps/server/src/application/agent/agent-application.service.ts:startNewAgentChat()` 调用；内部调用 `findUnique()`、`resolveContextWindowTokens()`、`resolveModelCapabilities()`、`getContextUsage()`、`readPiSessionContextUsage()`。
 */
async function resolveAgentContextUsage(
  userId: string,
  workspacePath: string,
  cwd: string,
  sessionId: string,
) {
  const settings = await resolveSelectedAiProviderProfile(userId);
  if (!settings) return null;
  const configuredContextWindow = await resolveContextWindowTokens(
    settings.model,
    settings.contextWindowTokens ?? undefined,
  );
  const contextWindow = resolveModelCapabilities({
    model: settings.model,
    baseUrl: settings.baseUrl,
    contextWindowTokens: configuredContextWindow,
  }).operationalContextWindowTokens;
  return codingAgentRuntime.getContextUsage(sessionId)
    ?? readPiSessionContextUsage(
      workspacePath,
      cwd,
      sessionId,
      contextWindow,
    );
}

/**
 * 功能：获取Agent 聊天 `snapshot`。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:inspectAgentChatContext()`、`apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspaceForUser()`、`getActiveChatSessionSnapshot()`、`resolveAgentContextUsage()`。
 */
export async function getAgentChatSnapshot(userId: string, mode: AgentMode = "work") {
  const context = await resolveAgentWorkspaceContext(userId, mode);
  const chat = await getActiveChatSessionSnapshot(
    context.workspace.path,
    context.cwd,
    context.owner,
  );
  return {
    ...chat,
    contextUsage: await resolveAgentContextUsage(
      userId,
      context.workspace.path,
      context.cwd,
      chat.session.sessionId,
    ),
  };
}

/**
 * 功能：获取Agent 聊天 上下文 占用信息。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspaceForUser()`、`ensureActiveChatSession()`、`resolveAgentContextUsage()`。
 */
export async function getAgentChatContextUsage(userId: string, mode: AgentMode = "work") {
  const context = await resolveAgentWorkspaceContext(userId, mode);
  const session = await ensureActiveChatSession(
    context.workspace.path,
    context.cwd,
    undefined,
    context.owner,
  );
  return resolveAgentContextUsage(
    userId,
    context.workspace.path,
    context.cwd,
    session.sessionId,
  );
}

/**
 * 功能：启动新会话 Agent 聊天。
 * 输入：`userId`（string）提供用户 id。 `email`（string）提供email。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `logInput()`、`logAutoReply()`、`getReadyWorkspaceForUser()`、`findFirst()`、`createNewChatSession()`、`clearWorkspaceContents()`。
 */
export async function startNewAgentChat(userId: string, email: string, mode: AgentMode = "work") {
  logInput(email, "/new (frontend direct)");
  logAutoReply(email, "command", "/new -> chat-sessions/new handler");
  const context = await resolveAgentWorkspaceContext(userId, mode);
  const { workspace } = context;
  const activeRun = await prisma.agentRun.findFirst({
    where: { userId, finishedAt: null },
    select: { id: true },
  });
  if (activeRun) throw new Error("仍有工作区任务正在运行。");

  let archivedSessionId: string | undefined;
  if (mode === "review") {
    const createdSession = await createNewChatSession({
      workspacePath: workspace.path,
      cwd: context.cwd,
      reason: "user_slash_new",
      confirmed: true,
      owner: context.owner,
      archivePreviousSession: async (session) => {
        archivedSessionId = session.sessionId;
      },
      resetWorkspace: async () => {
        await archiveWorkspaceUploads(workspace.path, archivedSessionId);
      },
    });
    if (archivedSessionId) {
      const retainedSessionIds = [createdSession.sessionId, archivedSessionId];
      await Promise.allSettled([
        retainArtifactsForSessions(workspace.path, retainedSessionIds),
        retainPiSessions(workspace.path, retainedSessionIds),
        retainChatSessions(workspace.path, retainedSessionIds, context.owner),
      ]);
    }
    const chat = await getActiveChatSessionSnapshot(
      workspace.path,
      context.cwd,
      context.owner,
    );
    return {
      ...chat,
      contextUsage: await resolveAgentContextUsage(
        userId,
        workspace.path,
        context.cwd,
        chat.session.sessionId,
      ),
    };
  }

  const createdSession = await createNewChatSession({
    workspacePath: workspace.path,
    cwd: workspace.path,
    reason: "user_slash_new",
    confirmed: true,
    owner: { userId, workspaceId: workspace.id },
    archivePreviousSession: async (session) => {
      await archiveActiveEvaluationSession({
        workspacePath: workspace.path,
        userId,
        session,
        reason: "user_slash_new",
      });
      archivedSessionId = session.sessionId;
    },
    resetWorkspace: async () => {
      await archiveWorkspaceUploads(workspace.path, archivedSessionId);
      await clearWorkspaceContents(workspace.path);
      await resetWorkspaceAgentRuntime(workspace.path);
      await resetCourseTaskContext(userId, workspace);
      await unlink(join(workspace.path, "..", ".project_status.md")).catch(() => undefined);
      await prisma.workspace.update({
        where: { id: workspace.id },
        data: { updatedAt: new Date() },
      });
    },
  });
  if (archivedSessionId) {
    const retainedSessionIds = [createdSession.sessionId, archivedSessionId];
    const cleanupResults = await Promise.allSettled([
      retainArtifactsForSessions(workspace.path, retainedSessionIds),
      retainPiSessions(workspace.path, retainedSessionIds),
      retainChatSessions(workspace.path, retainedSessionIds, {
        userId,
        workspaceId: workspace.id,
      }),
      retainLatestPastSessionArchive(workspace.path, archivedSessionId),
    ]);
    for (const result of cleanupResults) {
      if (result.status === "rejected") {
        logSystem(
          `Old session retention cleanup failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    }
  }
  await refreshEvaluationHistorySafely(workspace.path, userId);
  const chat = await getActiveChatSessionSnapshot(workspace.path, workspace.path, {
    userId,
    workspaceId: workspace.id,
  });
  return {
    ...chat,
    contextUsage: await resolveAgentContextUsage(
      userId,
      workspace.path,
      workspace.path,
      chat.session.sessionId,
    ),
  };
}

/**
 * 功能：压缩Agent 聊天。
 * 输入：`userId`（string）提供用户 id。 `email`（string）提供email。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `logInput()`、`logAutoReply()`、`getReadyWorkspaceForUser()`、`getActiveChatSessionSnapshot()`、`findUnique()`、`resolveContextWindowTokens()`。
 */
export async function compactAgentChat(userId: string, email: string, mode: AgentMode = "work") {
  logInput(email, "/compact (frontend direct)");
  logAutoReply(email, "command", "/compact -> chat-sessions/compact handler");
  const context = await resolveAgentWorkspaceContext(userId, mode);
  const { workspace } = context;
  const snapshot = await getActiveChatSessionSnapshot(
    workspace.path,
    context.cwd,
    context.owner,
  );
  const settings = await resolveSelectedAiProviderProfile(userId);
  if (!settings) throw new Error("请先在服务门户中配置 AI Provider。");
  const contextWindowTokens = await resolveContextWindowTokens(
    settings.model,
    settings.contextWindowTokens ?? undefined,
    prisma,
    settings.baseUrl,
  );
  const tokenQuota = await beginClassAiAgentQuota(userId, settings);
  try {
    return await codingAgentRuntime.compact({
      workspacePath: workspace.path,
      chatSession: snapshot.session,
      cwd: context.cwd,
      mode: context.mode,
      systemPrompt: context.systemPrompt,
      readableWorkspaceRoots: context.readableWorkspaceRoots,
      aiSettings: {
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        profileName: settings.name,
        profileSource: settings.source,
        temperature: settings.temperature ?? undefined,
        contextWindowTokens,
        reasoningEffort: normalizeReasoningEffortForModel(
          settings.model,
          settings.reasoningEffort,
          settings.baseUrl,
        ),
      },
      onTokenUsage: async (tokens) => { await tokenQuota.consume(tokens); },
    });
  } finally {
    await tokenQuota.release();
  }
}

/**
 * 功能：处理`inspect` Agent 聊天 上下文。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `getAgentChatSnapshot()`。
 */
export async function inspectAgentChatContext(userId: string, mode: AgentMode = "work") {
  const snapshot = await getAgentChatSnapshot(userId, mode);
  const history = snapshot.history ?? [];
  return {
    sessionId: snapshot.session.sessionId,
    title: snapshot.session.title,
    turnCount: snapshot.session.turnCount,
    messages: history.map((message) => ({
      role: message.role,
      content: message.content.slice(0, 200),
      createdAt: message.createdAt,
    })).slice(-20),
    totalMessages: history.length,
  };
}

/**
 * 功能：列出Agent 工具列表。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `listTools()`。
 */
export function listAgentTools(mode: AgentMode = "work") {
  return codingAgentRuntime.listTools(mode);
}

/**
 * 功能：获取Agent 产物 `download`。
 * 输入：`userId`（string）提供用户 id。 `artifactId`（string）提供产物 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspaceForUser()`、`getGeneratedArtifact()`、`recordChatSessionEvent()`。
 */
export async function getAgentArtifactDownload(userId: string, artifactId: string) {
  const workspace = await getReadyWorkspaceForUser(userId);
  const artifact = await getGeneratedArtifact(workspace.path, artifactId);
  if (!artifact) return null;
  await recordChatSessionEvent(workspace.path, artifact.sessionId, "artifact.downloaded", {
    artifactId: artifact.id,
    runId: artifact.runId,
    downloadName: artifact.downloadName,
  });
  return artifact;
}

/** Resolve an archived raster image for authenticated inline history preview. */
export async function getAgentAttachmentPreview(userId: string, artifactId: string) {
  const workspace = await getReadyWorkspaceForUser(userId);
  const artifact = await getConsumedArtifact(workspace.path, artifactId);
  if (!artifact || !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(artifact.mimeType)) {
    return null;
  }
  return artifact;
}

/**
 * 功能：停止Agent 运行。
 * 输入：`runId`（string）提供运行 id。 `userId`（string）提供用户 id。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `getOwnedAgentRun()`、`includes()`、`abort()`、`test()`、`update()`。
 */
export async function stopAgentRun(runId: string, userId: string) {
  const run = await getOwnedAgentRun(runId, userId);
  if (run.finishedAt || !ACTIVE_AGENT_RUN_STATUSES.includes(run.status)) {
    throw new Error("该工作区任务已不再运行。");
  }
  await codingAgentRuntime.abort(run.id);
  const chinese = /[\u3400-\u9fff]/u.test(run.prompt);
  const message = chinese
    ? "## 已停止\n\n任务已由用户停止。"
    : "## Stopped\n\nTask stopped by user.";
  return prisma.agentRun.update({
    where: { id: run.id },
    data: {
      status: "cancelled",
      currentStep: "cancelled",
      responseMarkdown: message,
      finalAnswerMarkdown: message,
      activityLogMarkdown: run.activityLogMarkdown ?? run.responseMarkdown ?? message,
      finishedAt: new Date(),
    },
  });
}

/**
 * 功能：列出Agent 运行列表。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `findMany()`。
 */
export function listAgentRuns(userId: string) {
  return prisma.agentRun.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 20,
    include: {
      patchPlans: { orderBy: { createdAt: "desc" }, take: 1 },
      buildRuns: { orderBy: { createdAt: "desc" }, take: 1 },
      qemuSmokeRuns: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
}

export { getAgentRunDetail };

/**
 * 功能：获取Agent 运行 `trace`。
 * 输入：`runId`（string）提供运行 id。 `userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `getOwnedAgentRun()`、`findMany()`。
 */
export async function getAgentRunTrace(runId: string, userId: string) {
  await getOwnedAgentRun(runId, userId);
  return prisma.agentTraceEvent.findMany({
    where: { agentRunId: runId },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * 功能：获取Agent 补丁 计划。
 * 输入：`patchPlanId`（string）提供补丁 计划 id。 `userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `findFirst()`。
 */
export function getAgentPatchPlan(patchPlanId: string, userId: string) {
  return prisma.agentPatchPlan.findFirst({
    where: { id: patchPlanId, agentRun: { userId } },
  });
}

/**
 * 功能：应用Agent 补丁 计划。
 * 输入：`patchPlanId`（string）提供补丁 计划 id。 `userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `findFirst()`、`createCheckpoint()`、`addTrace()`、`applyWorkspacePatch()`、`update()`。
 */
export async function applyAgentPatchPlan(patchPlanId: string, userId: string) {
  const patchPlan = await prisma.agentPatchPlan.findFirst({
    where: { id: patchPlanId, agentRun: { userId } },
    include: { agentRun: { include: { workspace: true } } },
  });
  if (!patchPlan) return null;
  if (patchPlan.status !== "generated") {
    throw new Error("当前补丁方案无法应用。");
  }
  const checkpoint = await createCheckpoint(
    patchPlan.agentRun.workspace,
    patchPlan.agentRunId,
    "Before applying agent patch",
  );
  await addTrace(patchPlan.agentRunId, AGENT_STEP_NAMES.patchApplication, "running", {
    inputSummaryMarkdown: "## Apply Patch\n\nUser confirmed patch application.",
  });
  await applyWorkspacePatch(patchPlan.agentRun.workspace.path, patchPlan.patch);
  const updated = await prisma.agentPatchPlan.update({
    where: { id: patchPlan.id },
    data: { status: "applied", appliedAt: new Date() },
  });
  await prisma.agentRun.update({
    where: { id: patchPlan.agentRunId },
    data: { status: "patch_applied", currentStep: AGENT_STEP_NAMES.patchApplication },
  });
  await addTrace(patchPlan.agentRunId, AGENT_STEP_NAMES.patchApplication, "success", {
    outputSummaryMarkdown: `## Patch Applied\n\nCheckpoint: \`${checkpoint.id}\``,
  });
  return {
    patchPlan: updated,
    checkpoint,
    messageMarkdown: `## Patch Applied\n\nCheckpoint created: \`${checkpoint.id}\`.`,
  };
}

/**
 * 功能：列出Agent 检查点列表。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspaceForUser()`、`findMany()`。
 */
export async function listAgentCheckpoints(userId: string) {
  const workspace = await getReadyWorkspaceForUser(userId);
  return prisma.checkpoint.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * 功能：恢复Agent 检查点。
 * 输入：`checkpointId`（string）提供检查点 id。 `userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspaceForUser()`、`restoreCheckpoint()`。
 */
export async function restoreAgentCheckpoint(checkpointId: string, userId: string) {
  const workspace = await getReadyWorkspaceForUser(userId);
  return restoreCheckpoint(checkpointId, workspace);
}

/**
 * 功能：构建Agent 运行。
 * 输入：`runId`（string）提供运行 id。 `userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `getOwnedAgentRun()`、`update()`、`addTrace()`、`runMakeBuild()`、`recordCourseTaskRunOutcome()`、`refreshEvaluationHistorySafely()`。
 */
export async function buildAgentRun(runId: string, userId: string) {
  const run = await getOwnedAgentRun(runId, userId);
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "build_running", currentStep: AGENT_STEP_NAMES.buildRun },
  });
  await addTrace(run.id, AGENT_STEP_NAMES.buildRun, "running", {
    inputSummaryMarkdown: "## Run Make\n\nCommand: `make`",
  });
  const buildRun = await runMakeBuild(run.id, run.workspace);
  await prisma.agentRun.update({
    where: { id: run.id },
    data: {
      status: buildRun.status === "success"
        ? "build_success"
        : buildRun.status === "resource_limit_exceeded" || buildRun.status === "idle_timeout"
          ? buildRun.status
          : "build_failed",
      currentStep: AGENT_STEP_NAMES.buildRun,
    },
  });
  await addTrace(
    run.id,
    AGENT_STEP_NAMES.buildRun,
    buildRun.status === "success" ? "success" : "failed",
    { outputSummaryMarkdown: buildRun.logSummaryMarkdown ?? undefined },
  );
  await recordCourseTaskRunOutcome({
    runId: run.id,
    courseTaskSessionId: run.courseTaskSessionId,
    courseSubtaskId: run.courseSubtaskId,
    prompt: run.prompt,
    finalAnswerMarkdown: run.finalAnswerMarkdown ?? run.responseMarkdown,
    buildStatus: buildRun.status,
    validationSummary: buildRun.logSummaryMarkdown ?? undefined,
  });
  await refreshEvaluationHistorySafely(run.workspace.path, userId);
  return buildRun;
}

/**
 * 功能：获取Agent QEMU 会话。
 * 输入：`runId`（string）提供运行 id。 `userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `getOwnedAgentRun()`、`getQemuSessionSnapshot()`。
 */
export async function getAgentQemuSession(runId: string, userId: string) {
  await getOwnedAgentRun(runId, userId);
  return getQemuSessionSnapshot(runId);
}

/**
 * 功能：启动Agent QEMU 会话。
 * 输入：`runId`（string）提供运行 id。 `userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `getOwnedAgentRun()`、`findFirst()`、`startQemuSession()`。
 */
export async function startAgentQemuSession(runId: string, userId: string) {
  const run = await getOwnedAgentRun(runId, userId);
  const lastBuild = await prisma.buildRun.findFirst({
    where: { agentRunId: run.id },
    orderBy: { createdAt: "desc" },
  });
  if (lastBuild?.status !== "success") {
    throw new Error("构建成功后才能启动交互式 QEMU。");
  }
  return startQemuSession(run.id, run.workspace.id, run.workspace.path);
}

/**
 * 功能：发送Agent QEMU 结构化输入。
 * 输入：`runId`（string）提供运行 id。 `userId`（string）提供用户 id。 `input`（string）提供当前操作所需的结构化输入。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `getOwnedAgentRun()`、`sendQemuSessionInput()`。
 */
export async function sendAgentQemuInput(runId: string, userId: string, input: string) {
  await getOwnedAgentRun(runId, userId);
  return sendQemuSessionInput(runId, input);
}

/**
 * 功能：停止Agent QEMU 会话。
 * 输入：`runId`（string）提供运行 id。 `userId`（string）提供用户 id。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `getOwnedAgentRun()`、`stopQemuSession()`。
 */
export async function stopAgentQemuSession(runId: string, userId: string) {
  await getOwnedAgentRun(runId, userId);
  return stopQemuSession(runId);
}

/**
 * 功能：处理`smoke` `test` Agent 运行。
 * 输入：`runId`（string）提供运行 id。 `userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `getOwnedAgentRun()`、`findFirst()`、`update()`、`addTrace()`、`runQemuSmoke()`、`recordCourseTaskRunOutcome()`。
 */
export async function smokeTestAgentRun(runId: string, userId: string) {
  const run = await getOwnedAgentRun(runId, userId);
  const lastBuild = await prisma.buildRun.findFirst({
    where: { agentRunId: run.id },
    orderBy: { createdAt: "desc" },
  });
  if (lastBuild?.status !== "success") {
    throw new Error("Make 构建成功后才能运行 QEMU 冒烟测试。");
  }
  await prisma.agentRun.update({
    where: { id: run.id },
    data: { status: "qemu_running", currentStep: AGENT_STEP_NAMES.qemuSmokeRun },
  });
  await addTrace(run.id, AGENT_STEP_NAMES.qemuSmokeRun, "running", {
    inputSummaryMarkdown: "## Run QEMU Smoke\n\nCommand: `make qemu-smoke`",
  });
  const qemuSmokeRun = await runQemuSmoke(run.id, run.workspace);
  await prisma.agentRun.update({
    where: { id: run.id },
    data: {
      status: qemuSmokeRun.status === "success"
        ? "qemu_success"
        : qemuSmokeRun.status === "resource_limit_exceeded" || qemuSmokeRun.status === "idle_timeout"
          ? qemuSmokeRun.status
          : "qemu_failed",
      currentStep: AGENT_STEP_NAMES.qemuSmokeRun,
    },
  });
  await addTrace(
    run.id,
    AGENT_STEP_NAMES.qemuSmokeRun,
    qemuSmokeRun.status === "success" ? "success" : "failed",
    { outputSummaryMarkdown: qemuSmokeRun.outputSummaryMarkdown ?? undefined },
  );
  await recordCourseTaskRunOutcome({
    runId: run.id,
    courseTaskSessionId: run.courseTaskSessionId,
    courseSubtaskId: run.courseSubtaskId,
    prompt: run.prompt,
    finalAnswerMarkdown: run.finalAnswerMarkdown ?? run.responseMarkdown,
    qemuStatus: qemuSmokeRun.status,
    validationSummary: qemuSmokeRun.outputSummaryMarkdown ?? undefined,
  });
  await refreshEvaluationHistorySafely(run.workspace.path, userId);
  return qemuSmokeRun;
}

/**
 * 功能：分析Agent 构建结果。
 * 输入：`buildRunId`（string）提供构建结果 运行 id。 `userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `all()`、`findFirst()`、`findUnique()`、`analyzeBuildError()`、`update()`、`addTrace()`。
 */
export async function analyzeAgentBuild(buildRunId: string, userId: string) {
  const [buildRun, settings] = await Promise.all([
    prisma.buildRun.findFirst({
      where: { id: buildRunId, agentRun: { userId } },
    }),
    resolveSelectedAiProviderProfile(userId),
  ]);
  if (!buildRun || !settings) return null;
  const analysisMarkdown = await analyzeBuildError(
    { apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model },
    buildRun.log,
  );
  const updated = await prisma.buildRun.update({
    where: { id: buildRun.id },
    data: { analysisMarkdown },
  });
  await addTrace(buildRun.agentRunId, AGENT_STEP_NAMES.buildErrorAnalysis, "success", {
    outputSummaryMarkdown: analysisMarkdown,
  });
  return updated;
}

/**
 * 功能：分析Agent QEMU 运行。
 * 输入：`qemuRunId`（string）提供QEMU 运行 id。 `userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程` 调用；内部调用 `all()`、`findFirst()`、`findUnique()`、`analyzeQemuOutput()`、`update()`、`addTrace()`。
 */
export async function analyzeAgentQemuRun(qemuRunId: string, userId: string) {
  const [qemuRun, settings] = await Promise.all([
    prisma.qemuSmokeRun.findFirst({
      where: { id: qemuRunId, agentRun: { userId } },
    }),
    resolveSelectedAiProviderProfile(userId),
  ]);
  if (!qemuRun || !settings) return null;
  const analysisMarkdown = await analyzeQemuOutput(
    { apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model },
    qemuRun.output,
  );
  const updated = await prisma.qemuSmokeRun.update({
    where: { id: qemuRun.id },
    data: { analysisMarkdown },
  });
  await addTrace(qemuRun.agentRunId, AGENT_STEP_NAMES.qemuOutputAnalysis, "success", {
    outputSummaryMarkdown: analysisMarkdown,
  });
  return updated;
}
