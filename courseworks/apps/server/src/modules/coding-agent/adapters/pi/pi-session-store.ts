/**
 * 文件作用：实现后端“Coding Agent 与 Pi 适配”业务模块的数据持久化与读取。
 * 模块位置：`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts`，属于后端“Coding Agent 与 Pi 适配”业务模块。
 * 重要函数：`piSessionRoot()` 负责处理Pi 会话 根目录；`piSessionPath()` 负责处理Pi 会话 路径；`parseTimestamp()` 负责解析`timestamp`；`legacyMessageToPi()` 负责处理`legacy` 消息 `to` Pi；`openPiSession()` 负责打开Pi 会话；`hasOnlyThinking()` 负责判断是否包含`only` `thinking`；`findRunEntry()` 负责查找运行 `entry`；`recoverFailedThinkingTail()` 负责处理`recover` `failed` `thinking` `tail`。
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  calculateContextTokens,
  estimateContextTokens,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import {
  getLatestCompactionEntry,
  SessionManager,
  type SessionEntry,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";

import { sessionStateRoot } from "../../../conversations/index.js";
import { readTranscriptHistory } from "../../../conversations/index.js";
import type { ChatHistoryMessage } from "../../../conversations/index.js";
import type { AgentContextUsage } from "../../coding-agent-runtime.js";

const PI_SESSION_DIRECTORY = "pi-sessions";
const COURSEWORKS_RUN_ENTRY = "courseworks.agent-run";
const COURSEWORKS_MODEL_ENTRY = "courseworks.model-configuration";
const COURSEWORKS_RECOVERY_ENTRY = "courseworks.session-recovery";

export type PiModelConfiguration = {
  provider: string;
  model: string;
  baseUrl: string;
};

const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

/**
 * 功能：处理Pi 会话 根目录。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:piSessionPath()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:openPiSession()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:readPiSessionHistory()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:readPiSessionContextUsage()` 调用；内部调用 `sessionStateRoot()`。
 */
export function piSessionRoot(workspacePath: string) {
  return path.join(sessionStateRoot(workspacePath), PI_SESSION_DIRECTORY);
}

/**
 * 功能：处理Pi 会话 路径。
 * 输入：`workspacePath`（string）提供工作区 路径。 `sessionId`（string）提供会话 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.test.ts 顶层流程`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:openPiSession()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:readPiSessionHistory()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:readPiSessionContextUsage()` 调用；内部调用 `piSessionRoot()`。
 */
export function piSessionPath(workspacePath: string, sessionId: string) {
  return path.join(piSessionRoot(workspacePath), `${sessionId}.jsonl`);
}

/** Retain Pi runtime state for only the active and latest archived chat sessions. */
export async function retainPiSessions(workspacePath: string, retainedSessionIds: string[]) {
  const retained = new Set(retainedSessionIds);
  const root = piSessionRoot(workspacePath);
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let removedFiles = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const sessionId = entry.name.slice(0, -".jsonl".length);
    if (retained.has(sessionId)) continue;
    await fs.rm(path.join(root, entry.name), { force: true });
    removedFiles += 1;
  }
  return { removedFiles };
}

/**
 * 功能：解析`timestamp`。
 * 输入：`value`（string）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:legacyMessageToPi()` 调用；内部调用 `parse()`、`isFinite()`、`now()`。
 */
function parseTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

/**
 * 功能：处理`legacy` 消息 `to` Pi。
 * 输入：`message`（ChatHistoryMessage）提供消息。
 * 输出：返回 Message，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:openPiSession()` 调用；内部调用 `parseTimestamp()`。
 */
function legacyMessageToPi(message: ChatHistoryMessage): Message {
  if (message.role === "user") {
    return {
      role: "user",
      content: [{ type: "text", text: message.content }],
      timestamp: parseTimestamp(message.createdAt),
    };
  }
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: message.content }],
    api: "openai-completions",
    provider: "courseworks-legacy",
    model: "legacy",
    usage: EMPTY_USAGE,
    stopReason: "stop",
    timestamp: parseTimestamp(message.createdAt),
  };
  return assistant;
}

/**
 * 功能：打开Pi 会话。
 * 输入：`workspacePath`（string）提供工作区 路径。 `cwd`（string）提供cwd。 `sessionId`（string）提供会话 id。
 * 输出：返回 Promise<{ sessionManager: SessionManager; migratedMessages: number; recoveredThinkingRuns: number; }>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.test.ts 顶层流程`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:createPiSession()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.test.ts 顶层流程` 调用；内部调用 `piSessionPath()`、`piSessionRoot()`、`mkdir()`、`access()`、`open()`、`recoverFailedThinkingTail()`。
 */
export async function openPiSession(
  workspacePath: string,
  cwd: string,
  sessionId: string,
): Promise<{
  sessionManager: SessionManager;
  migratedMessages: number;
  recoveredThinkingRuns: number;
}> {
  const sessionFile = piSessionPath(workspacePath, sessionId);
  const sessionDir = piSessionRoot(workspacePath);
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });

  let exists = true;
  try {
    await fs.access(sessionFile);
  } catch {
    exists = false;
  }

  const sessionManager = SessionManager.open(sessionFile, sessionDir, cwd);
  if (exists) {
    return {
      sessionManager,
      migratedMessages: 0,
      recoveredThinkingRuns: recoverFailedThinkingTail(sessionManager),
    };
  }

  const legacyHistory = await readTranscriptHistory(workspacePath, sessionId, 10_000);
  for (const message of legacyHistory) {
    sessionManager.appendMessage(legacyMessageToPi(message));
  }
  sessionManager.appendCustomEntry("courseworks.session-migration", {
    source: "legacy-transcript",
    migratedMessages: legacyHistory.length,
    migratedAt: new Date().toISOString(),
  });
  return {
    sessionManager,
    migratedMessages: legacyHistory.length,
    recoveredThinkingRuns: 0,
  };
}

/**
 * 功能：判断是否包含`only` `thinking`。
 * 输入：`messageEntry`（SessionMessageEntry）提供消息 entry。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:recoverFailedThinkingTail()` 调用；内部调用 `isArray()`。
 */
function hasOnlyThinking(messageEntry: SessionMessageEntry) {
  const message = messageEntry.message;
  if (message.role !== "assistant") return false;
  if (message.stopReason !== "aborted" && message.stopReason !== "length") return false;
  if (!Array.isArray(message.content)) return false;
  let hasThinking = false;
  for (const part of message.content) {
    if (part.type === "thinking") {
      hasThinking ||= part.thinking.trim().length > 0;
      continue;
    }
    if (part.type === "text" && part.text.trim().length === 0) continue;
    return false;
  }
  return hasThinking;
}

/**
 * 功能：查找运行 `entry`。
 * 输入：`sessionManager`（SessionManager）提供会话 manager。 `parentId`（string | null）提供parent id。
 * 输出：返回 SessionEntry | undefined，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:recoverFailedThinkingTail()` 调用；内部调用 `getEntry()`。
 */
function findRunEntry(
  sessionManager: SessionManager,
  parentId: string | null,
): SessionEntry | undefined {
  let entry = parentId ? sessionManager.getEntry(parentId) : undefined;
  while (entry) {
    if (entry.type === "custom" && entry.customType === COURSEWORKS_RUN_ENTRY) return entry;
    if (entry.type === "message") return undefined;
    entry = entry.parentId ? sessionManager.getEntry(entry.parentId) : undefined;
  }
  return undefined;
}

/**
 * 功能：处理`recover` `failed` `thinking` `tail`。
 * 输入：`sessionManager`（SessionManager）提供会话 manager。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:openPiSession()` 调用；内部调用 `getLeafEntry()`、`hasOnlyThinking()`、`getEntry()`、`findRunEntry()`、`branch()`、`resetLeaf()`。
 */
function recoverFailedThinkingTail(sessionManager: SessionManager) {
  const abandonedEntryIds: string[] = [];
  let branchTargetId: string | null | undefined;

  while (true) {
    const assistantEntry = sessionManager.getLeafEntry();
    if (!assistantEntry || assistantEntry.type !== "message" || !hasOnlyThinking(assistantEntry)) break;
    const userEntry = assistantEntry.parentId
      ? sessionManager.getEntry(assistantEntry.parentId)
      : undefined;
    if (!userEntry || userEntry.type !== "message" || userEntry.message.role !== "user") break;
    const runEntry = findRunEntry(sessionManager, userEntry.parentId);
    if (!runEntry) break;

    abandonedEntryIds.push(runEntry.id, userEntry.id, assistantEntry.id);
    branchTargetId = runEntry.parentId;
    if (branchTargetId) sessionManager.branch(branchTargetId);
    else sessionManager.resetLeaf();
  }

  if (abandonedEntryIds.length === 0) return 0;
  sessionManager.appendCustomEntry(COURSEWORKS_RECOVERY_ENTRY, {
    recoveredAt: new Date().toISOString(),
    abandonedEntryIds,
    recoveredRuns: abandonedEntryIds.length / 3,
  });
  return abandonedEntryIds.length / 3;
}

/**
 * 功能：解析模型 配置。
 * 输入：`value`（unknown）提供value。
 * 输出：返回 PiModelConfiguration | null，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:getPiSessionModelConfiguration()` 调用。
 */
function parseModelConfiguration(value: unknown): PiModelConfiguration | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as {
    provider?: unknown;
    model?: unknown;
    baseUrl?: unknown;
  };
  if (
    typeof candidate.provider !== "string"
    || typeof candidate.model !== "string"
    || typeof candidate.baseUrl !== "string"
  ) {
    return null;
  }
  return {
    provider: candidate.provider,
    model: candidate.model,
    baseUrl: candidate.baseUrl,
  };
}

/**
 * 功能：获取Pi 会话 模型 配置。
 * 输入：`sessionManager`（SessionManager）提供会话 manager。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.test.ts 顶层流程`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:createPiSession()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.test.ts 顶层流程`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:recordPiSessionModelConfiguration()` 调用；内部调用 `getBranch()`、`parseModelConfiguration()`。
 */
export function getPiSessionModelConfiguration(sessionManager: SessionManager) {
  const entries = sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "custom" && entry.customType === COURSEWORKS_MODEL_ENTRY) {
      const configuration = parseModelConfiguration(entry.data);
      if (configuration) return configuration;
    }
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "message" && entry.message.role === "assistant") {
      return {
        provider: entry.message.provider,
        model: entry.message.model,
        baseUrl: "",
      };
    }
    if (entry.type === "model_change") {
      return {
        provider: entry.provider,
        model: entry.modelId,
        baseUrl: "",
      };
    }
  }
  return null;
}

/**
 * 功能：处理模型 配置 `changed`。
 * 输入：`previous`（PiModelConfiguration | null）提供previous。 `current`（PiModelConfiguration）提供current。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:createPiSession()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.test.ts 顶层流程` 调用。
 */
export function modelConfigurationChanged(
  previous: PiModelConfiguration | null,
  current: PiModelConfiguration,
) {
  if (!previous) return false;
  return previous.provider !== current.provider
    || previous.model !== current.model
    || Boolean(previous.baseUrl && previous.baseUrl !== current.baseUrl);
}

/**
 * 功能：记录Pi 会话 模型 配置。
 * 输入：`sessionManager`（SessionManager）提供会话 manager。 `current`（PiModelConfiguration）提供current。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:prepareModelConfiguration()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:compact()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.test.ts 顶层流程` 调用；内部调用 `getPiSessionModelConfiguration()`、`appendModelChange()`、`appendCustomEntry()`。
 */
export function recordPiSessionModelConfiguration(
  sessionManager: SessionManager,
  current: PiModelConfiguration,
) {
  const previous = getPiSessionModelConfiguration(sessionManager);
  if (
    previous?.provider === current.provider
    && previous.model === current.model
    && previous.baseUrl === current.baseUrl
  ) {
    return;
  }
  sessionManager.appendModelChange(current.provider, current.model);
  sessionManager.appendCustomEntry(COURSEWORKS_MODEL_ENTRY, current);
}

/**
 * 功能：处理消息 `text`。
 * 输入：`content`（unknown）提供content。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:readPiSessionHistory()` 调用；内部调用 `isArray()`。
 */
function messageText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

/**
 * 功能：读取Pi 会话 历史记录。
 * 输入：`workspacePath`（string）提供工作区 路径。 `cwd`（string）提供cwd。 `sessionId`（string）提供会话 id。 `limit`提供limit。
 * 输出：返回 Promise<ChatHistoryMessage[] | null>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.test.ts 顶层流程`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.test.ts 顶层流程` 调用；内部调用 `piSessionPath()`、`access()`、`open()`、`piSessionRoot()`、`getBranch()`、`messageText()`。
 */
export async function readPiSessionHistory(
  workspacePath: string,
  cwd: string,
  sessionId: string,
  limit = 200,
): Promise<ChatHistoryMessage[] | null> {
  const sessionFile = piSessionPath(workspacePath, sessionId);
  try {
    await fs.access(sessionFile);
  } catch {
    return null;
  }

  const manager = SessionManager.open(sessionFile, piSessionRoot(workspacePath), cwd);
  const messages: ChatHistoryMessage[] = [];
  let currentRunId: string | undefined;
  for (const entry of manager.getBranch()) {
    if (entry.type === "custom" && entry.customType === COURSEWORKS_RUN_ENTRY) {
      const data = entry.data;
      currentRunId = typeof data === "object"
        && data !== null
        && typeof (data as { runId?: unknown }).runId === "string"
        ? (data as { runId: string }).runId
        : undefined;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = messageText(message.content).trim();
    if (!content) continue;
    messages.push({
      id: entry.id,
      role: message.role,
      content,
      createdAt: new Date(message.timestamp).toISOString(),
      ...(currentRunId ? { runId: currentRunId } : {}),
    });
  }
  return messages.slice(-limit);
}

/**
 * 功能：处理`valid` 助手消息 上下文 Token 数量。
 * 输入：`message`（AgentMessage）提供消息。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:readPiSessionContextUsage()` 调用；内部调用 `calculateContextTokens()`。
 */
function validAssistantContextTokens(message: AgentMessage) {
  if (message.role !== "assistant") return null;
  if (message.stopReason === "aborted" || message.stopReason === "error") return null;
  const tokens = calculateContextTokens(message.usage);
  return tokens > 0 ? tokens : null;
}

/**
 * 功能：读取Pi 会话 上下文 占用信息。
 * 输入：`workspacePath`（string）提供工作区 路径。 `cwd`（string）提供cwd。 `sessionId`（string）提供会话 id。 `contextWindow`（number）提供上下文 window。
 * 输出：返回 Promise<AgentContextUsage>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:resolveAgentContextUsage()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.test.ts 顶层流程` 调用；内部调用 `piSessionPath()`、`access()`、`open()`、`piSessionRoot()`、`getBranch()`、`getLatestCompactionEntry()`。
 */
export async function readPiSessionContextUsage(
  workspacePath: string,
  cwd: string,
  sessionId: string,
  contextWindow: number,
): Promise<AgentContextUsage> {
  const sessionFile = piSessionPath(workspacePath, sessionId);
  try {
    await fs.access(sessionFile);
  } catch {
    return { tokens: 0, contextWindow, percent: 0 };
  }

  const manager = SessionManager.open(sessionFile, piSessionRoot(workspacePath), cwd);
  const branchEntries = manager.getBranch();
  const latestCompaction = getLatestCompactionEntry(branchEntries);
  if (latestCompaction) {
    const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
    const hasUsageAfterCompaction = branchEntries
      .slice(compactionIndex + 1)
      .some((entry) => entry.type === "message"
        && validAssistantContextTokens(entry.message) !== null);
    if (!hasUsageAfterCompaction) {
      return { tokens: null, contextWindow, percent: null };
    }
  }

  const messages = manager.buildSessionContext().messages;
  const tokens = estimateContextTokens(messages).tokens;
  return {
    tokens,
    contextWindow,
    percent: contextWindow > 0 ? (tokens / contextWindow) * 100 : null,
  };
}
