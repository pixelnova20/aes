/**
 * 文件作用：实现后端“课程会话与历史记录”业务模块的数据持久化与读取。
 * 模块位置：`apps/server/src/modules/conversations/session-store.ts`，属于后端“课程会话与历史记录”业务模块。
 * 重要函数：`normalizePrompt()` 负责规范化提示词；`truncate()` 负责处理`truncate`；`deriveSessionTitle()` 负责推导会话 `title`；`ensureSessionStateRoot()` 负责确保会话 `state` 根目录；`loadSessionStore()` 负责加载会话 `store`；`saveSessionStore()` 负责保存会话 `store`；`createSessionEntry()` 负责创建会话 `entry`；`listSessionsForKey()` 负责列出会话列表 `for` `key`。
 */
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { sessionStateRoot, sessionStorePath } from "./session-paths.js";
import { assertWorkspaceWriteAllowed } from "../workspaces/index.js";
import type { SessionCreatedReason, SessionStoreState, StudentSession } from "./session-types.js";

export const DEFAULT_SESSION_TITLE = "Current conversation";

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
 * 输入：`value`（string）提供value。 `max`（number）提供max。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:safeJson()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:buildFallbackAnswer()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:persist()`、`apps/server/src/modules/conversations/session-store.ts:deriveSessionTitle()`、`apps/server/src/modules/conversations/session-store.ts:createSessionEntry()` 调用。
 */
function truncate(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

/**
 * 功能：推导会话 `title`。
 * 输入：`prompt`（string）提供提示词。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/conversations/session-store.ts:createSessionEntry()` 调用；内部调用 `find()`、`split()`、`truncate()`。
 */
export function deriveSessionTitle(prompt?: string) {
  const firstLine = (prompt ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return truncate(firstLine || DEFAULT_SESSION_TITLE, 80);
}

/**
 * 功能：确保会话 `state` 根目录。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/conversations/session-store.ts:loadSessionStore()`、`apps/server/src/modules/conversations/session-store.ts:saveSessionStore()` 调用；内部调用 `mkdir()`、`sessionStateRoot()`。
 */
async function ensureSessionStateRoot(workspacePath: string) {
  await fs.mkdir(sessionStateRoot(workspacePath), { recursive: true, mode: 0o700 });
}

// 这个加载函数同时承担旧版 store 的兼容迁移，把没有 sessionKey 的旧数据
// 自动归并到当前逻辑会话键下，避免刷新后历史突然“消失”。
/**
 * 功能：加载会话 `store`。
 * 输入：`workspacePath`（string）提供工作区 路径。 `sessionKey`（string）提供会话 key。
 * 输出：返回 Promise<SessionStoreState>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:resolveSessionStoreContext()`、`apps/server/src/modules/conversations/chat-session.service.ts:recordChatSessionEvent()` 调用；内部调用 `ensureSessionStateRoot()`、`parse()`、`readFile()`、`sessionStorePath()`、`fromEntries()`、`entries()`。
 */
export async function loadSessionStore(workspacePath: string, sessionKey: string): Promise<SessionStoreState> {
  await ensureSessionStateRoot(workspacePath);
  try {
    const parsed = JSON.parse(await fs.readFile(sessionStorePath(workspacePath), "utf8")) as Partial<SessionStoreState> & {
      sessions?: Record<string, Partial<StudentSession> & { messageCount?: number; status?: string }>;
      activeSessionKeys?: Record<string, string | null>;
    };
    const sessions = Object.fromEntries(Object.entries(parsed.sessions ?? {}).map(([sessionId, entry]) => [
      sessionId,
      {
        sessionId,
        sessionKey: typeof entry.sessionKey === "string" && entry.sessionKey.trim() ? entry.sessionKey : sessionKey,
        title: typeof entry.title === "string" ? entry.title : DEFAULT_SESSION_TITLE,
        createdAt: typeof entry.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date().toISOString(),
        turnCount: typeof entry.turnCount === "number"
          ? entry.turnCount
          : typeof entry.messageCount === "number"
            ? entry.messageCount
            : 0,
        lastPromptPreview: typeof entry.lastPromptPreview === "string" ? entry.lastPromptPreview : undefined,
        status: ((entry.status as string | undefined) === "superseded" || (entry.status as string | undefined) === "archived") ? "superseded" : "active",
        closedAt: typeof entry.closedAt === "string" ? entry.closedAt : undefined,
        closeReason: typeof entry.closeReason === "string" ? entry.closeReason : undefined
      } satisfies StudentSession
    ]));
    const activeSessionKeys = { ...(parsed.activeSessionKeys ?? {}) };
    if (!(sessionKey in activeSessionKeys)) {
      const legacyCurrent = typeof parsed.currentSessionId === "string"
        ? sessions[parsed.currentSessionId]
        : undefined;
      activeSessionKeys[sessionKey] = legacyCurrent?.sessionKey === sessionKey
        ? legacyCurrent.sessionId
        : null;
    }
    const mappedSessionId = activeSessionKeys[sessionKey];
    if (mappedSessionId && sessions[mappedSessionId]?.sessionKey !== sessionKey) {
      activeSessionKeys[sessionKey] = null;
    }
    const currentSessionId = typeof activeSessionKeys[sessionKey] === "string" && sessions[activeSessionKeys[sessionKey] as string]
      ? activeSessionKeys[sessionKey] as string
      : null;
    return {
      version: 3,
      currentSessionId,
      activeSessionKeys,
      sessions
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 3, currentSessionId: null, activeSessionKeys: { [sessionKey]: null }, sessions: {} };
    }
    throw error;
  }
}

/**
 * 功能：保存会话 `store`。
 * 输入：`workspacePath`（string）提供工作区 路径。 `store`（SessionStoreState）提供store。 `sessionKey`（string）提供会话 key。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:ensureActiveChatSession()`、`apps/server/src/modules/conversations/chat-session.service.ts:recordChatSessionEvent()`、`apps/server/src/modules/conversations/chat-session.service.ts:getActiveChatSessionSnapshot()`、`apps/server/src/modules/conversations/chat-session.service.ts:createNewChatSession()` 调用；内部调用 `ensureSessionStateRoot()`、`writeFile()`、`sessionStorePath()`、`stringify()`、`chmod()`。
 */
export async function saveSessionStore(workspacePath: string, store: SessionStoreState, sessionKey: string) {
  await ensureSessionStateRoot(workspacePath);
  const nextStore: SessionStoreState = {
    ...store,
    version: 3,
    currentSessionId: store.activeSessionKeys[sessionKey] ?? null
  };
  const serialized = `${JSON.stringify(nextStore, null, 2)}\n`;
  const previousSize = await fs.stat(sessionStorePath(workspacePath)).then((stat) => stat.size).catch(() => 0);
  await assertWorkspaceWriteAllowed(workspacePath, Math.max(0, Buffer.byteLength(serialized) - previousSize));
  await fs.writeFile(sessionStorePath(workspacePath), serialized, { mode: 0o600 });
  await fs.chmod(sessionStorePath(workspacePath), 0o600);
}

/**
 * 功能：创建会话 `entry`。
 * 输入：`sessionKey`（string）提供会话 key。 `prompt`（string | undefined）提供提示词。 `reason`（SessionCreatedReason）提供reason。
 * 输出：返回 StudentSession，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:ensureActiveChatSession()`、`apps/server/src/modules/conversations/chat-session.service.ts:createNewChatSession()` 调用；内部调用 `toISOString()`、`randomUUID()`、`deriveSessionTitle()`、`truncate()`、`normalizePrompt()`。
 */
export function createSessionEntry(sessionKey: string, prompt: string | undefined, reason: SessionCreatedReason): StudentSession {
  const now = new Date().toISOString();
  return {
    sessionId: randomUUID(),
    sessionKey,
    title: deriveSessionTitle(prompt),
    createdAt: now,
    updatedAt: now,
    turnCount: 0,
    ...(prompt?.trim() ? { lastPromptPreview: truncate(normalizePrompt(prompt), 120) } : {}),
    status: "active",
    ...(reason === "user_slash_new" ? { closeReason: reason } : {})
  };
}

/**
 * 功能：列出会话列表 `for` `key`。
 * 输入：`store`（SessionStoreState）提供store。 `sessionKey`（string）提供会话 key。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:listChatSessions()` 调用；内部调用 `sort()`、`values()`、`localeCompare()`。
 */
export function listSessionsForKey(store: SessionStoreState, sessionKey: string) {
  return Object.values(store.sessions)
    .filter((session) => session.sessionKey === sessionKey)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * 功能：标记会话 `superseded`。
 * 输入：`session`（StudentSession）提供会话。 `closedAt`（string）提供closed at。 `reason`（string）提供reason。
 * 输出：返回 StudentSession，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:createNewChatSession()` 调用。
 */
export function markSessionSuperseded(session: StudentSession, closedAt: string, reason: string): StudentSession {
  return {
    ...session,
    status: "superseded",
    updatedAt: closedAt,
    closedAt,
    closeReason: reason
  };
}
