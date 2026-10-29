/**
 * 文件作用：实现后端“Coding Agent 与 Pi 适配”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts`，属于后端“Coding Agent 与 Pi 适配”业务模块。
 * 重要函数：`getLastAssistantMessage()` 负责从 Pi Session 中查找最后一条 AssistantMessage；`createPiSession()` 负责创建并配置 Courseworks 使用的 Pi Agent Session；`prepareModelConfiguration()` 负责处理模型切换前的上下文检查与会话压缩。
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";

import { config } from "../../../../config/index.js";
import { logLlmResponse, logSystem } from "../../../../infrastructure/logging/logger.js";
import { sessionStateRoot } from "../../../conversations/index.js";
import {
  normalizeProviderBaseUrl,
  resolveModelCapabilities,
} from "../../../ai-settings/index.js";
import type {
  AgentAiSettings,
  AgentImageInput,
  CodingAgentRunInput,
  CodingAgentRuntime,
  CompactAgentSessionInput,
} from "../../coding-agent-runtime.js";
import {
  courseworksToolInfo,
  courseworksReviewToolInfo,
  createCourseworksToolDefinitions,
  createCourseworksReviewToolDefinitions,
  SANDBOX_WORKSPACE_PATH,
} from "./courseworks-tools.js";
import { type AgentRunStore, PrismaAgentRunStore } from "../../../agent-runs/index.js";
import { PiRunEventSink } from "./pi-run-event-sink.js";
import { RunProgress } from "./run-progress.js";
import {
  getPiSessionModelConfiguration,
  modelConfigurationChanged,
  openPiSession,
  recordPiSessionModelConfiguration,
  type PiModelConfiguration,
} from "./pi-session-store.js";
import { stopGraphicalQemuSession, resourceEvent } from "../../../execution/index.js";

const PROVIDER_ID = "courseworks-openai-compatible";
const WORK_TOOL_NAMES = ["read", "bash", "edit", "write"];
const REVIEW_TOOL_NAMES = ["ls", "grep", "read"];

type ActiveRun = {
  sessionId: string;
  session: AgentSession;
};

const REASONING_MESSAGE_FIELDS = [
  "reasoning_content",
  "reasoning",
  "reasoning_text",
  "reasoning_details",
] as const;

type MutableAssistantMessage = AssistantMessage & Record<string, unknown>;

/** Build non-secret runtime metadata that the model cannot discover from sandbox files. */
export function buildRuntimeAiIdentityPrompt(settings: AgentAiSettings) {
  const profileName = settings.profileName?.trim() || "未命名配置";
  const profileSource = settings.profileSource === "class" ? "班级强制配置" : "个人配置";
  const reasoningEffort = settings.reasoningEffort || "default";
  return [
    "The following AES runtime metadata is authoritative for this request:",
    `- AI provider profile: ${JSON.stringify(profileName)} (${profileSource})`,
    `- LLM model: ${JSON.stringify(settings.model)}`,
    `- reasoning level: ${JSON.stringify(reasoningEffort)}`,
    "If the user asks which model, LLM, provider profile, or reasoning level is currently in use, answer directly from this metadata.",
    "Do not search workspace files, environment variables, or Pi configuration to infer these values.",
  ].join("\n");
}

/**
 * 功能：移除模型偶尔以普通文本形式输出的内部 thinking 标记。
 * 输入：`text`（string）提供 assistant 文本。
 * 输出：返回清理后的文本和移除的标记数量。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:sanitizeOutboundContext()` 调用。
 */
function stripThinkingMarkup(text: string) {
  let strippedBlocks = 0;
  const cleaned = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, () => {
    strippedBlocks += 1;
    return "";
  });
  return { text: cleaned, strippedBlocks };
}

/**
 * 功能：清理发给 AI provider 的历史 assistant reasoning。
 * 输入：`context`（Context）提供即将发送的消息上下文。 `preserveReasoning`（boolean）表示 provider 是否明确要求保留 reasoning continuation 字段。
 * 输出：返回清理后的 Context 以及清理统计信息；原始 session 消息不会被修改。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:createPiSession()` 调用；内部处理 assistant 消息、thinking block 和 reasoning 字段。
 */
export function sanitizeOutboundContext(context: Context, preserveReasoning: boolean) {
  if (preserveReasoning) {
    return {
      context,
      strippedThinkingBlocks: 0,
      strippedReasoningFields: 0,
      strippedThinkingMarkup: 0,
    };
  }

  let strippedThinkingBlocks = 0;
  let strippedReasoningFields = 0;
  let strippedThinkingMarkup = 0;
  const messages: Message[] = [];

  for (const message of context.messages) {
    if (message.role !== "assistant") {
      messages.push(message);
      continue;
    }

    const content: AssistantMessage["content"] = message.content.flatMap((block): AssistantMessage["content"] => {
      if (block.type === "thinking") {
        strippedThinkingBlocks += 1;
        return [];
      }
      if (block.type !== "text") return [block];

      const cleaned = stripThinkingMarkup(block.text);
      strippedThinkingMarkup += cleaned.strippedBlocks;
      if (cleaned.text.length === 0) return [];
      return cleaned.text === block.text ? [block] : [{ ...block, text: cleaned.text }];
    });

    const cleanedMessage = { ...message, content } as MutableAssistantMessage;
    for (const field of REASONING_MESSAGE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(cleanedMessage, field)) {
        delete cleanedMessage[field];
        strippedReasoningFields += 1;
      }
    }
    if (cleanedMessage.content.length > 0) messages.push(cleanedMessage);
  }

  return {
    context: { ...context, messages },
    strippedThinkingBlocks,
    strippedReasoningFields,
    strippedThinkingMarkup,
  };
}

/**
 * 功能：从 Pi Session 中查找最后一条 AssistantMessage。
 * 输入：`session`（AgentSession）提供会话。
 * 输出：返回 AssistantMessage | undefined，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()` 调用。
 */
function getLastAssistantMessage(session: AgentSession): AssistantMessage | undefined {
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message.role === "assistant") return message;
  }
  return undefined;
}

/**
 * 功能：创建并配置 Courseworks 使用的 Pi Agent Session。
 * 输入：`input`（{ workspacePath: string; cwd: string; sessionId: string; aiSettings: AgentAiSettings; llmTimeoutMs: number; }）提供当前操作所需的结构化输入。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:compact()` 调用；内部调用 `openPiSession()`、`resolveModelCapabilities()`、`normalizeProviderBaseUrl()`、`getPiSessionModelConfiguration()`、`modelConfigurationChanged()`、`sessionStateRoot()`。
 */
async function createPiSession(input: {
  workspacePath: string;
  cwd: string;
  sessionId: string;
  userId?: string;
  workspaceId?: string;
  aiSettings: AgentAiSettings;
  llmTimeoutMs: number;
  displaySessionId?: string;
  onMutation?: CodingAgentRunInput["onMutation"];
  mode?: "work" | "review";
  systemPrompt?: string;
  readableWorkspaceRoots?: string[];
  onModelProgress?: () => void;
}) {
  const {
    sessionManager,
    migratedMessages,
    recoveredThinkingRuns,
  } = await openPiSession(
    input.workspacePath,
    input.cwd,
    input.sessionId,
  );
  const capabilities = resolveModelCapabilities(input.aiSettings);
  const currentModelConfiguration: PiModelConfiguration = {
    provider: PROVIDER_ID,
    model: input.aiSettings.model,
    baseUrl: normalizeProviderBaseUrl(input.aiSettings.baseUrl),
  };
  const previousModelConfiguration = getPiSessionModelConfiguration(sessionManager);
  const modelChanged = modelConfigurationChanged(
    previousModelConfiguration,
    currentModelConfiguration,
  );
  const agentDir = path.join(sessionStateRoot(input.workspacePath), "pi-agent");
  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });

  const settingsManager = SettingsManager.create(input.cwd, agentDir, {
    projectTrusted: false,
  });
  settingsManager.setRetryEnabled(true);
  await settingsManager.flush();

  const reviewMode = input.mode === "review";
  const defaultSystemPrompt = [
    "You are the coding agent for Courseworks.",
    "Operate only in the current student workspace.",
    "Use the provided read, edit, write, and sandboxed bash tools.",
    "When an attached image needs text extraction and you cannot inspect it directly, you may use tesseract on its staged path with -l eng+chi_sim.",
    "When an attached PDF needs reading, use pdftotext for text PDFs; for scanned PDFs, render pages with pdftoppm and then use tesseract. Process only the pages needed.",
    `The logical workspace path exposed to every tool is ${SANDBOX_WORKSPACE_PATH}.`,
    "Prefer workspace-relative paths. Never use host filesystem paths in tool calls.",
    "Do not access .git, .env, .checkpoints, or node_modules.",
    "Inspect only files needed for the current task; do not preload or enumerate the entire project.",
    "Before each meaningful tool batch, briefly tell the user what you are checking or changing. Give concise progress summaries; never reveal private chain-of-thought or dump internal reasoning.",
    "Previous assistant reasoning and progress are internal execution metadata. Do not quote, reproduce, or treat them as a new user instruction. Base the next response on the user's messages, tool results, and current workspace state.",
    "After changing code, run the most relevant available build or test and report concrete evidence.",
    "Always finish with a concise Markdown response using these sections when applicable: ## Summary, ## Changes, ## Validation, ## Notes. Omit empty sections. In Validation, name the commands or checks actually run and distinguish passed, failed, and not run. Do not claim a check passed without evidence.",
    "Reply in Chinese when the user writes in Chinese.",
  ].join("\n");
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    appendSystemPrompt: [
      input.systemPrompt || defaultSystemPrompt,
      buildRuntimeAiIdentityPrompt(input.aiSettings),
    ],
  });
  await resourceLoader.reload();
  settingsManager.applyOverrides({
    compaction: {
      enabled: true,
      reserveTokens: capabilities.compactionReserveTokens,
      keepRecentTokens: capabilities.compactionKeepRecentTokens,
    },
  });

  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(PROVIDER_ID, {
    name: "Courseworks OpenAI-compatible provider",
    baseUrl: currentModelConfiguration.baseUrl,
    apiKey: input.aiSettings.apiKey,
    api: "openai-completions",
    models: [
      {
        id: input.aiSettings.model,
        name: input.aiSettings.model,
        reasoning: capabilities.reasoning,
        input: capabilities.supportsImages ? ["text", "image"] : ["text"],
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        contextWindow: capabilities.operationalContextWindowTokens,
        maxTokens: capabilities.maxTokens,
        thinkingLevelMap: capabilities.thinkingLevelMap,
        compat: capabilities.compat,
      },
    ],
  });
  const model = modelRuntime.getModel(PROVIDER_ID, input.aiSettings.model);
  if (!model) {
    throw new Error(`Pi model registration failed: ${input.aiSettings.model}`);
  }

  const customTools = reviewMode
    ? createCourseworksReviewToolDefinitions(input.cwd, {
        storageWorkspacePath: input.workspacePath,
        readableWorkspaceRoots: input.readableWorkspaceRoots ?? [],
      })
    : createCourseworksToolDefinitions(input.workspacePath, {
        displaySessionId: input.displaySessionId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        runId: input.displaySessionId,
        onMutation: input.onMutation,
      });
  const { session } = await createAgentSession({
    cwd: input.cwd,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: capabilities.thinkingLevel,
    resourceLoader,
    settingsManager,
    sessionManager,
    tools: reviewMode ? REVIEW_TOOL_NAMES : WORK_TOOL_NAMES,
    customTools,
  });
  const streamFunction = session.agent.streamFunction;
  const hostCwd = input.cwd.replace(/\\/g, "/");
  let llmTimedOut = false;
  session.agent.streamFunction = async (streamModel, context, options) => {
    const timeout = setTimeout(() => {
      llmTimedOut = true;
      resourceEvent("agent_model_idle_timeout", { runId: input.displaySessionId, idleTimeoutMs: input.llmTimeoutMs });
      session.abortCompaction();
      void session.abort().catch(() => undefined);
    }, input.llmTimeoutMs);
    /**
     * 功能：清理请求 `timeout`。
     * 输入：无显式输入参数。
     * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
     * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:createPiSession()` 调用；内部调用 `clearTimeout()`。
     */
    const clearRequestTimeout = () => {
      clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", clearRequestTimeout);
    };
    options?.signal?.addEventListener("abort", clearRequestTimeout, { once: true });
    if (options?.signal?.aborted) clearRequestTimeout();
    try {
      const sanitized = sanitizeOutboundContext(
        context,
        capabilities.compat.requiresReasoningContentOnAssistantMessages === true,
      );
      if (
        sanitized.strippedThinkingBlocks > 0
        || sanitized.strippedReasoningFields > 0
        || sanitized.strippedThinkingMarkup > 0
      ) {
        const logId = input.displaySessionId ?? input.sessionId;
        logSystem(
          `[${logId.slice(0, 8)}] Pi context sanitized: model=${streamModel.id}`
          + ` thinkingBlocks=${sanitized.strippedThinkingBlocks}`
          + ` reasoningFields=${sanitized.strippedReasoningFields}`
          + ` thinkingMarkup=${sanitized.strippedThinkingMarkup}`,
        );
      }
      const stream = await streamFunction(
        streamModel,
        {
          ...sanitized.context,
          systemPrompt: context.systemPrompt?.replaceAll(hostCwd, SANDBOX_WORKSPACE_PATH),
        },
        {
          ...options,
          ...(input.aiSettings.temperature !== undefined
            ? { temperature: input.aiSettings.temperature }
            : {}),
        },
      );
      // Observe the actual stream, including compaction streams that bypass session events.
      const push = stream.push.bind(stream);
      stream.push = event => {
        if (!llmTimedOut && !options?.signal?.aborted && "delta" in event && typeof event.delta === "string" && event.delta.length > 0) {
          timeout.refresh();
          input.onModelProgress?.();
        }
        push(event);
      };
      void stream.result().then(clearRequestTimeout, clearRequestTimeout);
      return stream;
    } catch (error) {
      clearRequestTimeout();
      throw error;
    }
  };
  return {
    session,
    sessionManager,
    migratedMessages,
    recoveredThinkingRuns,
    capabilities,
    currentModelConfiguration,
    previousModelConfiguration,
    modelChanged,
    didLlmTimeout: () => llmTimedOut,
  };
}

/**
 * 功能：处理模型切换前的上下文检查与会话压缩。
 * 输入：`input`（{ runId: string; session: AgentSession; sessionManager: Awaited<ReturnType<typeof openPiSession>>["sessionManager"]; cap）提供当前操作所需的结构化输入。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()` 调用；内部调用 `getContextUsage()`、`compact()`、`recordPiSessionModelConfiguration()`、`appendTrace()`、`stringify()`。
 */
async function prepareModelConfiguration(input: {
  runId: string;
  session: AgentSession;
  sessionManager: Awaited<ReturnType<typeof openPiSession>>["sessionManager"];
  capabilities: ReturnType<typeof resolveModelCapabilities>;
  current: PiModelConfiguration;
  previous: PiModelConfiguration | null;
  changed: boolean;
  runStore: AgentRunStore;
}) {
  const usage = input.session.getContextUsage();
  if (
    input.changed
    && usage?.tokens !== null
    && usage?.tokens !== undefined
    && usage.tokens >= input.capabilities.compactionTriggerTokens
  ) {
    try {
      await input.session.compact();
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      const previousModel = input.previous?.model
        ? `（${input.previous.model}）`
        : "";
      throw new Error(
        `切换到模型 ${input.current.model} 后，会话压缩失败。原 Pi Session 已保留，系统没有创建新 Session，也没有执行本轮任务。请在 Settings 中切回之前的模型${previousModel}后重试。压缩错误：${cause}`,
      );
    }
  }

  recordPiSessionModelConfiguration(input.sessionManager, input.current);
  if (input.changed) {
    await input.runStore.appendTrace(input.runId, {
      stepName: "pi:model_change",
      stepStatus: "success",
      outputSummaryMarkdown: `Model changed from ${input.previous?.model ?? "unknown"} to ${input.current.model}.`,
      debugMarkdown: JSON.stringify({
        previous: input.previous,
        current: input.current,
        contextTokens: usage?.tokens ?? null,
        compactionTriggerTokens: input.capabilities.compactionTriggerTokens,
      }),
    });
  }
}

export class PiCodingAgentRuntime implements CodingAgentRuntime {
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly activeSessions = new Map<string, string>();
  private readonly cancelledRuns = new Set<string>();
  private readonly runStore: AgentRunStore;
  private readonly llmTimeoutMs: number;

  /**
   * 功能：初始化 Pi Coding Agent runtime 及运行存储依赖。
   * 输入：`runStore`（AgentRunStore）提供运行 store。 `llmTimeoutMs`提供llm timeout ms。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由创建该类实例的代码自动调用。
   */
  constructor(
    runStore: AgentRunStore = new PrismaAgentRunStore(),
    llmTimeoutMs = config.AGENT_LLM_TIMEOUT_MS,
  ) {
    this.runStore = runStore;
    this.llmTimeoutMs = llmTimeoutMs;
  }

  /**
   * 功能：列出工具列表。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:handleTools()`、`apps/server/src/application/agent/agent-application.service.ts:listAgentTools()` 调用；内部调用 `courseworksToolInfo()`。
   */
  listTools(mode: "work" | "review" = "work") {
    return mode === "review" ? courseworksReviewToolInfo() : courseworksToolInfo();
  }

  /**
   * 功能：获取上下文 占用信息。
   * 输入：`sessionId`（string）提供会话 id。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:resolveAgentContextUsage()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:prepareModelConfiguration()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:getContextUsage()` 调用；内部调用 `getContextUsage()`。
   */
  getContextUsage(sessionId: string) {
    const runId = this.activeSessions.get(sessionId);
    if (!runId) return undefined;
    return this.activeRuns.get(runId)?.session.getContextUsage();
  }

  /**
   * 功能：执行`run` 对应的数据。
   * 输入：`input`（CodingAgentRunInput）提供当前操作所需的结构化输入。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:submitAgentPrompt()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.test.ts 顶层流程` 调用；内部调用 `fail()`、`createPiSession()`、`has()`、`bind()`、`appendCustomEntry()`、`toISOString()`。
   */
  async run(input: CodingAgentRunInput) {
    const sessionId = input.chatSession.sessionId;
    const existingRunId = this.activeSessions.get(sessionId);
    if (existingRunId) {
      await this.runStore.fail(
        input.runId,
        `Chat session is already running Agent Run ${existingRunId}.`,
      );
      throw new Error(`Chat session is already running Agent Run ${existingRunId}.`);
    }
    this.activeSessions.set(sessionId, input.runId);
    const runStartedAt = Date.now();
    let runTimedOut = false;
    const deadlineMs = config.WORKSPACE_AGENT_RUN_TIMEOUT_MS;
    resourceEvent("agent_run_started", { runId: input.runId, workspaceId: input.workspaceId, userId: input.userId, deadlineMs, idleTimeoutMs: config.AGENT_RUN_IDLE_TIMEOUT_MS, repeatLimit: config.AGENT_RUN_REPEAT_LIMIT, modelIdleTimeoutMs: this.llmTimeoutMs });
    const deadlineTimer = deadlineMs > 0 ? setTimeout(() => {
      runTimedOut = true;
      resourceEvent("agent_run_timeout", { runId: input.runId, workspaceId: input.workspaceId, deadlineMs });
      stopGraphicalQemuSession(input.runId);
      this.activeRuns.get(input.runId)?.session.abortCompaction();
      void this.activeRuns.get(input.runId)?.session.abort().catch(() => undefined);
    }, deadlineMs) : undefined;

    let session: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let eventSink: PiRunEventSink | undefined;
    let progressUnsubscribe: (() => void) | undefined;
    let progressTimer: ReturnType<typeof setInterval> | undefined;
    let progressStop: string | undefined;
    let warned = false;
    let lastProgressLog = Date.now();
    let latestAssistant: AssistantMessage | undefined;
    let compactedAfterAssistant = false;
    let compactionFailure: string | undefined;
    let recoveryAttempts = 0;
    const progress = new RunProgress(config.AGENT_RUN_IDLE_TIMEOUT_MS, config.AGENT_RUN_REPEAT_LIMIT, Date.now());
    let quotaExceeded = false;
    /**
     * 功能：处理`did` `llm` `timeout`。
     * 输入：无显式输入参数。
     * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
     * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()` 调用。
     */
    let didLlmTimeout = () => false;
    try {
      const created = await createPiSession({
        workspacePath: input.workspacePath,
        cwd: input.cwd,
        sessionId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        aiSettings: input.aiSettings,
        llmTimeoutMs: this.llmTimeoutMs,
        displaySessionId: input.runId,
        onMutation: input.onMutation,
        mode: input.mode,
        systemPrompt: input.systemPrompt,
        readableWorkspaceRoots: input.readableWorkspaceRoots,
        onModelProgress: () => { progress.lastActivity = Date.now(); },
      });
      didLlmTimeout = created.didLlmTimeout;
      session = created.session;
      this.activeRuns.set(input.runId, { sessionId, session });
      const checkProgress = () => {
        if (progressStop) return;
        if (Date.now() - lastProgressLog >= 60000) {
          lastProgressLog = Date.now();
          resourceEvent("agent_run_progress", { runId: input.runId, workspaceId: input.workspaceId, durationMs: Date.now() - runStartedAt, idleMs: Date.now() - progress.lastActivity, repeated: progress.repeated });
        }
        const reason = progress.reason(Date.now());
        if (reason) {
          progressStop = reason;
          resourceEvent("agent_run_progress_stopped", { runId: input.runId, workspaceId: input.workspaceId, reason, idleMs: Date.now() - progress.lastActivity, repeated: progress.repeated });
          stopGraphicalQemuSession(input.runId);
          session?.abortCompaction();
          void session?.abort().catch(() => undefined);
        } else if (progress.warning(Date.now()) && !warned) {
          warned = true;
          resourceEvent("agent_run_progress_warning", { runId: input.runId, workspaceId: input.workspaceId, repeated: progress.repeated, idleMs: Date.now() - progress.lastActivity });
          void this.runStore.appendTrace(input.runId, { stepName: "pi:progress_warning", stepStatus: "running", outputSummaryMarkdown: "任务较长时间没有新活动，或正在重复相同工具结果；若持续无进展，系统将停止本轮并保留会话。" }).catch(() => undefined);
        } else if (!progress.warning(Date.now())) warned = false;
      };
      progressUnsubscribe = session.subscribe(event => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          latestAssistant = event.message;
          compactedAfterAssistant = false;
          compactionFailure = undefined;
        }
        if (event.type === "compaction_end") {
          compactedAfterAssistant = Boolean(event.result && !event.aborted && !event.errorMessage);
          compactionFailure = event.errorMessage || (event.aborted ? "上下文压缩已取消" : undefined);
        }
        progress.observe(event, Date.now());
        checkProgress();
      });
      progressTimer = setInterval(checkProgress, Math.min(1000, config.AGENT_RUN_IDLE_TIMEOUT_MS));
      if (runTimedOut) throw new Error("Agent Run deadline exceeded.");
      if (this.cancelledRuns.has(input.runId)) {
        throw new Error("Agent Run cancelled before Pi session startup completed.");
      }
      eventSink = new PiRunEventSink(input.runId, this.runStore, async (tokens) => {
        if (!input.onTokenUsage) return;
        quotaExceeded = await input.onTokenUsage(tokens);
        if (quotaExceeded) {
          session?.abortCompaction();
          await session?.abort();
        }
      });
      unsubscribe = eventSink.bind(session);
      created.sessionManager.appendCustomEntry("courseworks.agent-run", {
        runId: input.runId,
        startedAt: new Date().toISOString(),
      });

      if (created.migratedMessages > 0) {
        await this.runStore.appendTrace(input.runId, {
          stepName: "pi:session_migrated",
          stepStatus: "success",
          outputSummaryMarkdown: `Migrated ${created.migratedMessages} legacy messages into the Pi session.`,
        });
      }
      if (created.recoveredThinkingRuns > 0) {
        await this.runStore.appendTrace(input.runId, {
          stepName: "pi:session_recovered",
          stepStatus: "success",
          outputSummaryMarkdown: `Skipped ${created.recoveredThinkingRuns} failed thinking-only run(s) in the active Pi session context.`,
        });
      }

      await prepareModelConfiguration({
        runId: input.runId,
        session,
        sessionManager: created.sessionManager,
        capabilities: created.capabilities,
        current: created.currentModelConfiguration,
        previous: created.previousModelConfiguration,
        changed: created.modelChanged,
        runStore: this.runStore,
      });

      logSystem(
        `[${input.runId.slice(0, 8)}] Pi Agent start: model=${input.aiSettings.model}, session=${sessionId.slice(0, 8)}`,
      );
      await session.prompt(input.prompt, {
        expandPromptTemplates: false,
        source: "rpc",
        ...(input.images?.length ? {
          images: input.images.map((image: AgentImageInput) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
        } : {}),
      });
      const assertCanRecover = () => {
        if (this.cancelledRuns.has(input.runId)) throw new Error("运行已取消。");
        if (quotaExceeded) throw new Error("今日班级 AI Token 配额已用完。");
        if (progressStop) throw new Error(progressStop);
        if (runTimedOut) throw new Error("Agent Run deadline exceeded.");
        if (created.didLlmTimeout()) throw new Error("模型长时间无新输出。");
      };
      // Read the observed terminal message: compaction may remove it from session.messages.
      while (latestAssistant?.stopReason === "length") {
        await eventSink.flush();
        assertCanRecover();
        if (recoveryAttempts >= config.AGENT_LENGTH_RECOVERY_MAX_ATTEMPTS) {
          throw new Error(`单次模型输出达到 Token 上限，自动恢复 ${recoveryAttempts} 次后仍未完成。会话和代码已保留，可调整模型后继续。`);
        }
        if (compactionFailure) throw new Error(`单次模型输出达到 Token 上限；上下文压缩未成功，未自动继续：${compactionFailure}`);
        recoveryAttempts++;
        await this.runStore.updateStatus(input.runId, "planning", "pi:length_recovery");
        await this.runStore.appendTrace(input.runId, {
          stepName: "pi:length_recovery", stepStatus: "running",
          outputSummaryMarkdown: `单次模型输出达到 Token 上限，正在压缩并继续原任务（${recoveryAttempts}/${config.AGENT_LENGTH_RECOVERY_MAX_ATTEMPTS}）。`,
        });
        resourceEvent("agent_run_length_recovery", { runId: input.runId, workspaceId: input.workspaceId, attempt: recoveryAttempts, reusedCompaction: compactedAfterAssistant });
        assertCanRecover();
        if (!compactedAfterAssistant) {
          await session.compact("Preserve the original user task, constraints, completed work, file changes, tool results, and remaining steps. Summarize briefly; do not reproduce lengthy internal reasoning.");
        }
        await eventSink.flush(); // Include compaction usage in the quota before issuing another request.
        assertCanRecover();
        if (!compactedAfterAssistant) throw new Error("上下文压缩未完成，已保留会话，未自动继续。");
        latestAssistant = undefined;
        await session.sendCustomMessage({
          customType: "courseworks.length-recovery",
          content: "AES automatic continuation: the previous response reached its output-token limit and the conversation has been compacted. Continue the SAME original user task from the summary and current workspace state. Preserve all original constraints. Do not restart completed work or blindly repeat side-effecting commands. Avoid repeating lengthy analysis; perform the next concrete step, verify the result, and provide a concise final answer when done.",
          display: true,
          details: { runId: input.runId, attempt: recoveryAttempts, reason: "output_token_limit" },
        }, { triggerTurn: true });
        await eventSink.flush();
        assertCanRecover();
        if (!latestAssistant) throw new Error("自动继续后模型未返回新的响应，会话已保留。");
      }
      if (progressTimer) clearInterval(progressTimer);
      progressUnsubscribe?.();
      progressUnsubscribe = undefined;
      await eventSink.flush();
      unsubscribe();
      unsubscribe = undefined;

      if (created.didLlmTimeout()) {
        throw new Error(
          `模型连续 ${Math.ceil(this.llmTimeoutMs / 1000)} 秒没有新输出，系统已中止本轮任务。会话和代码已保留，可发送消息继续。`,
        );
      }

      if (progressStop) throw new Error(progressStop);
      if (runTimedOut) throw new Error("Agent Run deadline exceeded.");
      if (this.cancelledRuns.has(input.runId)) {
        const cancelledAnswer = "运行已取消。";
        await this.runStore.cancel(input.runId, cancelledAnswer);
        await this.runStore.updateResponse(
          input.runId,
          eventSink.buildResponseMarkdown(cancelledAnswer),
        );
        logLlmResponse(input.email ?? "—", true, cancelledAnswer);
        return cancelledAnswer;
      }
      const lastAssistant = latestAssistant ?? getLastAssistantMessage(session);
      if (!lastAssistant) {
        throw new Error("模型没有返回 AssistantMessage，本轮任务未完成。");
      }
      if (lastAssistant.stopReason === "length") {
        throw new Error("单次模型输出达到 Token 上限，本轮任务未完成，会话和代码已保留。");
      }
      if (lastAssistant.stopReason === "error") {
        throw new Error(lastAssistant.errorMessage || "模型返回错误，本轮任务未完成。");
      }
      if (lastAssistant.stopReason === "aborted") {
        throw new Error("模型响应被中止，本轮任务未完成。");
      }
      const visibleAnswer = session.getLastAssistantText()?.trim();
      const finalAnswer = visibleAnswer
        || (eventSink.hasExecutionEvidence()
          ? eventSink.buildFallbackAnswer(/[\u3400-\u9fff]/u.test(input.prompt))
          : "");
      if (!finalAnswer) {
        throw new Error("模型正常结束但没有返回可显示的文本或工具执行结果，本轮任务未完成。");
      }
      await this.runStore.complete(input.runId, finalAnswer);
      await this.runStore.updateResponse(
        input.runId,
        eventSink.buildResponseMarkdown(finalAnswer),
      );
      logLlmResponse(input.email ?? "—", true, finalAnswer);
      return finalAnswer;
    } catch (error) {
      const message = progressStop
        ? `idle_timeout: ${progressStop === "repeated_tool_results" ? `连续 ${config.AGENT_RUN_REPEAT_LIMIT} 次工具结果重复，疑似循环` : `连续 ${Math.ceil(config.AGENT_RUN_IDLE_TIMEOUT_MS / 1000)} 秒没有新的模型输出或工具完成结果`}。本轮已停止，会话和代码已保留，可发送消息继续。`
        : runTimedOut
        ? `Agent Run exceeded its ${Math.ceil(deadlineMs / 1000)} second deadline.`
        : quotaExceeded
        ? "今日班级 AI Token 配额已用完，本轮 Courseworks 任务已停止。"
        : didLlmTimeout()
        ? `模型连续 ${Math.ceil(this.llmTimeoutMs / 1000)} 秒没有新输出，系统已中止本轮任务。会话和代码已保留，可发送消息继续。`
        : error instanceof Error ? error.message : "Unknown Pi Agent error";
      unsubscribe?.();
      unsubscribe = undefined;
      await eventSink?.flush();
      if (this.cancelledRuns.has(input.runId)) {
        await this.runStore.cancel(input.runId);
        await this.runStore.updateResponse(
          input.runId,
          eventSink?.buildResponseMarkdown("运行已取消。") ?? "运行已取消。",
        );
      } else if (message.startsWith("resource_limit_exceeded:") || message.startsWith("idle_timeout:")) {
        await this.runStore.fail(input.runId, message);
        const limitStatus = message.startsWith("idle_timeout:") ? "idle_timeout" : "resource_limit_exceeded";
        await this.runStore.updateStatus(input.runId, limitStatus, limitStatus);
        await this.runStore.updateResponse(
          input.runId,
          eventSink?.buildResponseMarkdown(`## 运行被资源限制终止\n\n${message}`)
            ?? `## 运行被资源限制终止\n\n${message}`,
        );
        await this.runStore.appendTrace(input.runId, {
          stepName: `pi:${limitStatus}`,
          stepStatus: "failed",
          errorMarkdown: message,
        });
      } else {
        await this.runStore.fail(input.runId, message);
        await this.runStore.updateResponse(
          input.runId,
          eventSink?.buildResponseMarkdown(`## 运行失败\n\n${message}`)
            ?? `## 运行失败\n\n${message}`,
        );
        await this.runStore.appendTrace(input.runId, {
          stepName: "pi:failed",
          stepStatus: "failed",
          errorMarkdown: message,
        });
      }
      logLlmResponse(input.email ?? "—", false, message);
      throw quotaExceeded || progressStop || didLlmTimeout() ? new Error(message) : error;
    } finally {
      if (progressTimer) clearInterval(progressTimer);
      progressUnsubscribe?.();
      if (deadlineTimer) clearTimeout(deadlineTimer);
      unsubscribe?.();
      await eventSink?.flush();
      session?.dispose();
      resourceEvent("agent_run_finished", { runId: input.runId, workspaceId: input.workspaceId, userId: input.userId, durationMs: Date.now() - runStartedAt, deadlineMs, timedOut: runTimedOut, progressStop, modelIdleTimeout: didLlmTimeout(), recoveryAttempts });
      stopGraphicalQemuSession(input.runId);
            this.activeRuns.delete(input.runId);
            this.activeSessions.delete(sessionId);
            this.cancelledRuns.delete(input.runId);
    }
  }

  /**
   * 功能：处理`abort`。
   * 输入：`runId`（string）提供运行 id。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:stopAgentRun()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:createPiSession()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:abort()`、`apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `add()`、`abort()`。
   */
  async abort(runId: string) {
    this.cancelledRuns.add(runId);
    stopGraphicalQemuSession(runId);
    const active = this.activeRuns.get(runId);
    if (!active) return;
    active.session.abortCompaction();
    await active.session.abort();
  }

  /**
   * 功能：压缩`compact` 对应的数据。
   * 输入：`input`（CompactAgentSessionInput）提供当前操作所需的结构化输入。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:compactAgentChat()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:prepareModelConfiguration()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:compact()`、`apps/web/src/features/workspace/WorkspaceSidebar.tsx:WorkspaceSidebar()` 调用；内部调用 `has()`、`createPiSession()`、`compact()`、`recordPiSessionModelConfiguration()`、`test()`、`normalizeProviderBaseUrl()`。
   */
  async compact(input: CompactAgentSessionInput) {
    const sessionId = input.chatSession.sessionId;
    if (this.activeSessions.has(sessionId)) {
      throw new Error("Cannot compact a chat session while an Agent Run is active.");
    }
    this.activeSessions.set(sessionId, "manual-compaction");

    let session: AgentSession | undefined;
    try {
      const created = await createPiSession({
        workspacePath: input.workspacePath,
        cwd: input.cwd,
        sessionId,
        aiSettings: input.aiSettings,
        llmTimeoutMs: this.llmTimeoutMs,
        mode: input.mode,
        systemPrompt: input.systemPrompt,
        readableWorkspaceRoots: input.readableWorkspaceRoots,
      });
      session = created.session;
      const beforeTurns = session.messages.length;
      const result = await session.compact();
      if (result.usage && input.onTokenUsage) {
        await input.onTokenUsage(
          Math.max(0, result.usage.input) + Math.max(0, result.usage.output),
        );
      }
      recordPiSessionModelConfiguration(
        created.sessionManager,
        created.currentModelConfiguration,
      );
      return {
        compacted: true,
        summary: result.summary,
        beforeTurns,
        afterTurns: session.messages.length,
      };
    } catch (error) {
      if (error instanceof Error && /Nothing to compact|Already compacted/.test(error.message)) {
        if (session) {
          const current = {
            provider: PROVIDER_ID,
            model: input.aiSettings.model,
            baseUrl: normalizeProviderBaseUrl(input.aiSettings.baseUrl),
          };
          recordPiSessionModelConfiguration(session.sessionManager, current);
        }
        return { compacted: false };
      }
      throw error;
    } finally {
      session?.dispose();
            this.activeSessions.delete(sessionId);
    }
  }
}
