/**
 * 文件作用：实现后端“课程会话与历史记录”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/conversations/chat-session.service.ts`，属于后端“课程会话与历史记录”业务模块。
 * 重要函数：`fallbackUserIdFromWorkspace()` 负责处理`fallback` 用户 `id` `from` 工作区；`resolveOwner()` 负责解析并确定归属信息；`resolveSessionStoreContext()` 负责解析并确定会话 `store` 上下文；`ensureActiveChatSession()` 负责确保`active` 聊天 会话；`recordChatSessionEvent()` 负责记录聊天 会话 `event`；`recordAttachmentConsumption()` 负责记录`attachment` `consumption`；`createGeneratedArtifactForSession()` 负责创建`generated` 产物 `for` 会话；`readChatSessionHistory()` 负责读取聊天 会话 历史记录。
 */
import {
  appendEventRecord,
  deleteTranscript,
  ensureTranscriptExists,
  readTranscriptHistory,
  writeSessionCreatedRecord,
} from "./transcript-store.js";
import { buildStudentSessionKey, normalizeSessionOwner } from "./session-key.js";
import {
  createSessionEntry,
  listSessionsForKey,
  loadSessionStore,
  markSessionSuperseded,
  saveSessionStore,
} from "./session-store.js";
import {
  createGeneratedArtifact,
  listConsumedArtifactsForSession,
} from "../artifacts/index.js";
import { readAgentConversationHistory } from "./conversation-history.port.js";
import type { ChatHistoryMessage, SessionOwner, StudentSession } from "./session-types.js";
import type {
  ConsumedArtifactRecord,
  GeneratedArtifactRecord,
  StagedUploadRecord,
} from "../artifacts/index.js";

const MEDIA_NOTE_LINE = /^\[media attached(?: \d+\/\d+)?: [^\]\r\n]+\]\r?\n?/gm;

/** Add archived attachments to their user turn without exposing internal staging paths. */
export function attachConsumedArtifactsToHistory(
  history: ChatHistoryMessage[],
  artifacts: ConsumedArtifactRecord[],
) {
  return history.map((message) => {
    if (message.role !== "user") return message;
    const attachments = artifacts.filter((artifact) => (
      artifact.runId && message.runId
        ? artifact.runId === message.runId
        : !artifact.runId && message.content.includes(artifact.sourceUploadId)
    ));
    if (!attachments.length) return message;
    return {
      ...message,
      content: message.content.replace(MEDIA_NOTE_LINE, "").replace(/\n{3,}/g, "\n\n").trim(),
      attachments: attachments.map((artifact) => ({
        id: artifact.id,
        originalName: artifact.originalName,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
      })),
    };
  });
}

export { DEFAULT_COURSE_ID } from "./session-key.js";

export type ChatSessionEntry = StudentSession;

/**
 * 功能：处理`fallback` 用户 `id` `from` 工作区。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:resolveOwner()`、`apps/server/src/modules/conversations/chat-session.service.ts:recordChatSessionEvent()` 调用。
 */
function fallbackUserIdFromWorkspace(workspacePath: string) {
  return `workspace:${workspacePath}`;
}

/**
 * 功能：解析并确定归属信息。
 * 输入：`workspacePath`（string）提供工作区 路径。 `owner`（Partial<SessionOwner>）提供归属信息。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:resolveSessionStoreContext()` 调用；内部调用 `normalizeSessionOwner()`、`fallbackUserIdFromWorkspace()`。
 */
function resolveOwner(workspacePath: string, owner?: Partial<SessionOwner>) {
  return normalizeSessionOwner(owner, fallbackUserIdFromWorkspace(workspacePath));
}

/**
 * 功能：解析并确定会话 `store` 上下文。
 * 输入：`workspacePath`（string）提供工作区 路径。 `owner`（Partial<SessionOwner>）提供归属信息。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:ensureActiveChatSession()`、`apps/server/src/modules/conversations/chat-session.service.ts:listChatSessions()`、`apps/server/src/modules/conversations/chat-session.service.ts:getActiveChatSessionSnapshot()`、`apps/server/src/modules/conversations/chat-session.service.ts:createNewChatSession()` 调用；内部调用 `resolveOwner()`、`buildStudentSessionKey()`、`loadSessionStore()`。
 */
async function resolveSessionStoreContext(workspacePath: string, owner?: Partial<SessionOwner>) {
  const normalizedOwner = resolveOwner(workspacePath, owner);
  const sessionKey = buildStudentSessionKey(normalizedOwner);
  const store = await loadSessionStore(workspacePath, sessionKey.value);
  return { owner: normalizedOwner, sessionKey, store };
}

// ensureActiveChatSession 是当前后端会话内核的统一入口：
// 它负责把“当前学生 + 当前课程”的逻辑身份解析到一个稳定的 active session。
/**
 * 功能：确保`active` 聊天 会话。
 * 输入：`workspacePath`（string）提供工作区 路径。 `cwd`（string）提供cwd。 `prompt`（string）提供提示词。 `owner`（Partial<SessionOwner>）提供归属信息。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:submitAgentPrompt()`、`apps/server/src/application/agent/agent-application.service.ts:getAgentChatContextUsage()`、`apps/server/src/modules/conversations/chat-session.service.ts:getActiveChatSessionSnapshot()` 调用；内部调用 `resolveSessionStoreContext()`、`ensureTranscriptExists()`、`createSessionEntry()`、`writeSessionCreatedRecord()`、`saveSessionStore()`。
 */
export async function ensureActiveChatSession(
  workspacePath: string,
  cwd: string,
  prompt?: string,
  owner?: Partial<SessionOwner>
) {
  const { sessionKey, store } = await resolveSessionStoreContext(workspacePath, owner);
  const currentId = store.activeSessionKeys[sessionKey.value];
  const current = currentId ? store.sessions[currentId] : null;
  if (current && current.status === "active") {
    await ensureTranscriptExists(workspacePath, cwd, current);
    return current;
  }
  const created = createSessionEntry(sessionKey.value, prompt, "auto_first_login");
  await writeSessionCreatedRecord(workspacePath, created, cwd, "auto_first_login");
  store.activeSessionKeys[sessionKey.value] = created.sessionId;
  store.currentSessionId = created.sessionId;
  store.sessions[created.sessionId] = created;
  await saveSessionStore(workspacePath, store, sessionKey.value);
  return created;
}

/**
 * 功能：记录聊天 会话 `event`。
 * 输入：`workspacePath`（string）提供工作区 路径。 `sessionId`（string）提供会话 id。 `name`（"session.superseded" | "workspace.reset" | "artifact.consumed" | "artifact.generated" | "artifact.downloaded" | "attachm）提供name。 `detail`（Record<string, unknown>）提供detail。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:getAgentArtifactDownload()`、`apps/server/src/modules/conversations/chat-session.service.ts:recordAttachmentConsumption()`、`apps/server/src/modules/conversations/chat-session.service.ts:createGeneratedArtifactForSession()`、`apps/server/src/modules/conversations/chat-session.service.ts:createNewChatSession()` 调用；内部调用 `loadSessionStore()`、`fallbackUserIdFromWorkspace()`、`find()`、`values()`、`appendEventRecord()`、`saveSessionStore()`。
 */
export async function recordChatSessionEvent(
  workspacePath: string,
  sessionId: string,
  name: "session.superseded" | "workspace.reset" | "artifact.consumed" | "artifact.generated" | "artifact.downloaded" | "attachments.consume_failed",
  detail: Record<string, unknown>
) {
  const fallbackStore = await loadSessionStore(workspacePath, fallbackUserIdFromWorkspace(workspacePath));
  const fallbackEntry = fallbackStore.sessions[sessionId];
  const sessionKey = fallbackEntry?.sessionKey ?? Object.values(fallbackStore.sessions).find((session) => session.sessionId === sessionId)?.sessionKey ?? fallbackUserIdFromWorkspace(workspacePath);
  const store = await loadSessionStore(workspacePath, sessionKey);
  const entry = store.sessions[sessionId];
  if (!entry) return;
  const record = await appendEventRecord(workspacePath, entry, name, detail);
  store.sessions[sessionId] = { ...entry, updatedAt: record.createdAt };
  await saveSessionStore(workspacePath, store, entry.sessionKey);
}

/**
 * 功能：记录`attachment` `consumption`。
 * 输入：`workspacePath`（string）提供工作区 路径。 `sessionId`（string）提供会话 id。 `turnId`（string）提供turn id。 `runId`（string）提供运行 id。 `uploads`（StagedUploadRecord[]）提供上传附件列表。 `artifacts`（ConsumedArtifactRecord[]）提供产物列表。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `recordChatSessionEvent()`。
 */
export async function recordAttachmentConsumption(
  workspacePath: string,
  sessionId: string,
  turnId: string | undefined,
  runId: string | undefined,
  uploads: StagedUploadRecord[],
  artifacts: ConsumedArtifactRecord[]
) {
  if (!uploads.length) return;
  await recordChatSessionEvent(workspacePath, sessionId, "artifact.consumed", {
    ...(turnId ? { turnId } : {}),
    ...(runId ? { runId } : {}),
    uploads: uploads.map((upload) => ({
      id: upload.id,
      originalName: upload.originalName,
      mimeType: upload.mimeType,
      size: upload.sizeBytes,
      sha256: upload.sha256
    })),
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      originalName: artifact.originalName,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256
    }))
  });
}

// createGeneratedArtifactForSession 统一负责“生成下载产物 + 写审计事件”，
// 避免调用方只写文件、不补 transcript，导致后续无法追溯 artifact 生命周期。
/**
 * 功能：创建`generated` 产物 `for` 会话。
 * 输入：`args`（{ workspacePath: string; session: StudentSession; turnId?: string; runId?: string; createdBy: "assistant" | "agent" | "s）提供args。
 * 输出：返回 Promise<GeneratedArtifactRecord>，供调用方继续处理。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `createGeneratedArtifact()`、`recordChatSessionEvent()`。
 */
export async function createGeneratedArtifactForSession(args: {
  workspacePath: string;
  session: StudentSession;
  turnId?: string;
  runId?: string;
  createdBy: "assistant" | "agent" | "system";
  displayName: string;
  downloadName: string;
  mimeType?: string;
  contentBytes: Uint8Array;
  summaryMarkdown?: string;
}): Promise<GeneratedArtifactRecord> {
  const artifact = await createGeneratedArtifact(args);
  await recordChatSessionEvent(args.workspacePath, args.session.sessionId, "artifact.generated", {
    artifactId: artifact.id,
    turnId: artifact.turnId ?? null,
    runId: artifact.runId ?? null,
    displayName: artifact.displayName,
    downloadName: artifact.downloadName,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    summaryMarkdown: artifact.summaryMarkdown ?? null
  });
  return artifact;
}

/**
 * 功能：读取聊天 会话 历史记录。
 * 输入：`workspacePath`（string）提供工作区 路径。 `sessionId`（string）提供会话 id。 `limit`提供limit。
 * 输出：返回 Promise<ChatHistoryMessage[]>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:getActiveChatSessionSnapshot()`、`apps/server/src/modules/evaluation-history/evaluation-history.service.ts:collectEvaluationHistory()` 调用；内部调用 `readAgentConversationHistory()`、`readTranscriptHistory()`。
 */
export async function readChatSessionHistory(workspacePath: string, sessionId: string, limit = 200): Promise<ChatHistoryMessage[]> {
  return (
    (await readAgentConversationHistory(workspacePath, workspacePath, sessionId, limit)) ??
    readTranscriptHistory(workspacePath, sessionId, limit)
  );
}

/**
 * 功能：列出聊天 会话列表。
 * 输入：`workspacePath`（string）提供工作区 路径。 `owner`（Partial<SessionOwner>）提供归属信息。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:getActiveChatSessionSnapshot()`、`apps/server/src/modules/evaluation-history/evaluation-history.service.ts:collectEvaluationHistory()` 调用；内部调用 `resolveSessionStoreContext()`、`listSessionsForKey()`。
 */
export async function listChatSessions(workspacePath: string, owner?: Partial<SessionOwner>) {
  const { sessionKey, store } = await resolveSessionStoreContext(workspacePath, owner);
  return {
    currentSessionId: store.activeSessionKeys[sessionKey.value] ?? null,
    sessions: listSessionsForKey(store, sessionKey.value)
  };
}

/** Retain only the active session and the one most recently archived session. */
export async function retainChatSessions(
  workspacePath: string,
  retainedSessionIds: string[],
  owner?: Partial<SessionOwner>,
) {
  const retained = new Set(retainedSessionIds);
  const { sessionKey, store } = await resolveSessionStoreContext(workspacePath, owner);
  const removedSessionIds: string[] = [];

  for (const sessionId of Object.keys(store.sessions)) {
    if (retained.has(sessionId)) continue;
    delete store.sessions[sessionId];
    removedSessionIds.push(sessionId);
    await deleteTranscript(workspacePath, sessionId);
  }
  for (const [key, sessionId] of Object.entries(store.activeSessionKeys)) {
    if (sessionId && !retained.has(sessionId)) store.activeSessionKeys[key] = null;
  }
  if (store.currentSessionId && !retained.has(store.currentSessionId)) {
    store.currentSessionId = store.activeSessionKeys[sessionKey.value] ?? null;
  }
  await saveSessionStore(workspacePath, store, sessionKey.value);
  return { removedSessionIds };
}

/**
 * 功能：获取`active` 聊天 会话 `snapshot`。
 * 输入：`workspacePath`（string）提供工作区 路径。 `cwd`（string）提供cwd。 `owner`（Partial<SessionOwner>）提供归属信息。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:getAgentChatSnapshot()`、`apps/server/src/application/agent/agent-application.service.ts:startNewAgentChat()`、`apps/server/src/application/agent/agent-application.service.ts:compactAgentChat()` 调用；内部调用 `ensureActiveChatSession()`、`readChatSessionHistory()`、`resolveSessionStoreContext()`、`at()`、`saveSessionStore()`、`listChatSessions()`。
 */
export async function getActiveChatSessionSnapshot(workspacePath: string, cwd: string, owner?: Partial<SessionOwner>) {
  const session = await ensureActiveChatSession(workspacePath, cwd, undefined, owner);
  const history = attachConsumedArtifactsToHistory(
    await readChatSessionHistory(workspacePath, session.sessionId),
    await listConsumedArtifactsForSession(workspacePath, session.sessionId),
  );
  const { sessionKey, store } = await resolveSessionStoreContext(workspacePath, owner);
  const existing = store.sessions[session.sessionId];
  if (existing && existing.turnCount !== history.length) {
    store.sessions[session.sessionId] = {
      ...existing,
      turnCount: history.length,
      updatedAt: history.at(-1)?.createdAt ?? existing.updatedAt,
    };
    await saveSessionStore(workspacePath, store, sessionKey.value);
  }
  const listing = await listChatSessions(workspacePath, owner);
  return {
    currentSessionId: listing.currentSessionId,
    session: listing.sessions.find((entry) => entry.sessionId === session.sessionId) ?? session,
    sessions: listing.sessions,
    history
  };
}

/**
 * 功能：校验新会话 会话 请求。
 * 输入：`confirmations`（{ reason?: string; confirmed?: boolean; }）提供confirmations。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:createNewChatSession()` 调用。
 */
function validateNewSessionRequest(confirmations: {
  reason?: string;
  confirmed?: boolean;
}) {
  if (confirmations.reason !== "user_slash_new") {
    throw new Error("Creating a new session is only allowed through the /new flow.");
  }
  if (!confirmations.confirmed) {
    throw new Error("The /new confirmation was not completed.");
  }
}

/**
 * 功能：创建新会话 聊天 会话。
 * 输入：`args`（{ workspacePath: string; cwd: string; reason: string; confirmed: boolean; resetWorkspace: () => Promise<void>; archivePreviousSession?: (session: StudentSession) => Promise<void>; owner?: P }）提供args。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:startNewAgentChat()` 调用；内部调用 `validateNewSessionRequest()`、`resolveSessionStoreContext()`、`resetWorkspace()`、`toISOString()`、`markSessionSuperseded()`、`appendEventRecord()`。
 */
export async function createNewChatSession(args: {
  workspacePath: string;
  cwd: string;
  reason: string;
  confirmed: boolean;
  resetWorkspace: () => Promise<void>;
  archivePreviousSession?: (session: StudentSession) => Promise<void>;
  owner?: Partial<SessionOwner>;
}) {
  validateNewSessionRequest(args);
  const { sessionKey, store } = await resolveSessionStoreContext(args.workspacePath, args.owner);
  const previousSessionId = store.activeSessionKeys[sessionKey.value];

  if (previousSessionId && store.sessions[previousSessionId] && args.archivePreviousSession) {
    await args.archivePreviousSession(store.sessions[previousSessionId]);
  }
  await args.resetWorkspace();

  const closedAt = new Date().toISOString();
  if (previousSessionId && store.sessions[previousSessionId]) {
    const previous = store.sessions[previousSessionId];
    store.sessions[previousSessionId] = markSessionSuperseded(
      previous,
      closedAt,
      "user_slash_new",
    );
    await appendEventRecord(args.workspacePath, previous, "session.superseded", {
      reason: "user_slash_new",
      closedAt,
    });
  }

  const created = createSessionEntry(sessionKey.value, undefined, "user_slash_new");
  await writeSessionCreatedRecord(args.workspacePath, created, args.cwd, "user_slash_new");
  store.activeSessionKeys[sessionKey.value] = created.sessionId;
  store.currentSessionId = created.sessionId;
  store.sessions[created.sessionId] = created;
  await saveSessionStore(args.workspacePath, store, sessionKey.value);
  await recordChatSessionEvent(args.workspacePath, created.sessionId, "workspace.reset", {
    reason: "user_slash_new"
  });
  return created;
}
