/**
 * 文件作用：实现后端“课程会话与历史记录”业务模块的数据持久化与读取。
 * 模块位置：`apps/server/src/modules/conversations/transcript-store.ts`，属于后端“课程会话与历史记录”业务模块。
 * 重要函数：`ensureTranscriptRoot()` 负责确保会话流水 根目录；`appendTranscriptRecord()` 负责追加会话流水 `record`；`writeSessionCreatedRecord()` 负责写入会话 `created` `record`；`ensureTranscriptExists()` 负责确保会话流水 `exists`；`appendTurnRecord()` 负责追加`turn` `record`；`appendEventRecord()` 负责追加`event` `record`；`readTranscriptHistory()` 负责读取会话流水 历史记录；`deleteTranscript()` 负责删除会话流水。
 */
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { logSystem } from "../../infrastructure/logging/logger.js";
import { assertWorkspaceWriteAllowed } from "../workspaces/index.js";
import { sessionStateRoot, sessionTranscriptPath } from "./session-paths.js";
import type {
  ChatHistoryMessage,
  SessionCreatedReason,
  SessionCreatedRecord,
  SessionEventName,
  SessionEventRecord,
  StudentSession,
  StudentTurn,
  TranscriptRecord
} from "./session-types.js";

/**
 * 功能：确保会话流水 根目录。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/conversations/transcript-store.ts:appendTranscriptRecord()`、`apps/server/src/modules/conversations/transcript-store.ts:writeSessionCreatedRecord()` 调用；内部调用 `mkdir()`、`sessionStateRoot()`。
 */
async function ensureTranscriptRoot(workspacePath: string) {
  await fs.mkdir(sessionStateRoot(workspacePath), { recursive: true, mode: 0o700 });
}

/**
 * 功能：追加会话流水 `record`。
 * 输入：`workspacePath`（string）提供工作区 路径。 `sessionId`（string）提供会话 id。 `record`（TranscriptRecord）提供record。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/modules/conversations/transcript-store.ts:appendTurnRecord()`、`apps/server/src/modules/conversations/transcript-store.ts:appendEventRecord()` 调用；内部调用 `ensureTranscriptRoot()`、`appendFile()`、`sessionTranscriptPath()`、`stringify()`。
 */
async function appendTranscriptRecord(workspacePath: string, sessionId: string, record: TranscriptRecord) {
  await ensureTranscriptRoot(workspacePath);
  const serialized = `${JSON.stringify(record)}\n`;
  await assertWorkspaceWriteAllowed(workspacePath, Buffer.byteLength(serialized));
  await fs.appendFile(sessionTranscriptPath(workspacePath, sessionId), serialized);
}

// transcript 文件头明确记录当前实例属于哪个 sessionKey，
// 这样后续排查“为什么落到了这个会话”时有稳定证据。
/**
 * 功能：写入会话 `created` `record`。
 * 输入：`workspacePath`（string）提供工作区 路径。 `entry`（StudentSession）提供entry。 `cwd`（string）提供cwd。 `reason`（SessionCreatedReason）提供reason。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.test.ts 顶层流程`、`apps/server/src/modules/conversations/chat-session.service.ts:ensureActiveChatSession()`、`apps/server/src/modules/conversations/chat-session.service.ts:createNewChatSession()`、`apps/server/src/modules/conversations/transcript-store.ts:ensureTranscriptExists()` 调用；内部调用 `randomUUID()`、`ensureTranscriptRoot()`、`writeFile()`、`sessionTranscriptPath()`、`stringify()`、`chmod()`。
 */
export async function writeSessionCreatedRecord(
  workspacePath: string,
  entry: StudentSession,
  cwd: string,
  reason: SessionCreatedReason
) {
  const header: SessionCreatedRecord = {
    type: "session.created",
    id: randomUUID(),
    sessionId: entry.sessionId,
    sessionKey: entry.sessionKey,
    createdAt: entry.createdAt,
    cwd,
    title: entry.title,
    reason
  };
  await ensureTranscriptRoot(workspacePath);
  const serialized = `${JSON.stringify(header)}\n`;
  await assertWorkspaceWriteAllowed(workspacePath, Buffer.byteLength(serialized));
  await fs.writeFile(sessionTranscriptPath(workspacePath, entry.sessionId), serialized, { mode: 0o600 });
  await fs.chmod(sessionTranscriptPath(workspacePath, entry.sessionId), 0o600);
}

/**
 * 功能：确保会话流水 `exists`。
 * 输入：`workspacePath`（string）提供工作区 路径。 `cwd`（string）提供cwd。 `entry`（StudentSession）提供entry。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:ensureActiveChatSession()` 调用；内部调用 `access()`、`sessionTranscriptPath()`、`writeSessionCreatedRecord()`。
 */
export async function ensureTranscriptExists(workspacePath: string, cwd: string, entry: StudentSession) {
  try {
    await fs.access(sessionTranscriptPath(workspacePath, entry.sessionId));
  } catch {
    await writeSessionCreatedRecord(workspacePath, entry, cwd, entry.closeReason === "user_slash_new" ? "user_slash_new" : "auto_first_login");
  }
}

/**
 * 功能：追加`turn` `record`。
 * 输入：`workspacePath`（string）提供工作区 路径。 `entry`（StudentSession）提供entry。 `message`（Omit<StudentTurn, "type" | "id" | "sessionId" | "sessionKey" | "createdAt">）提供消息。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.test.ts 顶层流程` 调用；内部调用 `randomUUID()`、`toISOString()`、`appendTranscriptRecord()`。
 */
export async function appendTurnRecord(
  workspacePath: string,
  entry: StudentSession,
  message: Omit<StudentTurn, "type" | "id" | "sessionId" | "sessionKey" | "createdAt">
) {
  const record: StudentTurn = {
    type: "turn",
    id: randomUUID(),
    sessionId: entry.sessionId,
    sessionKey: entry.sessionKey,
    createdAt: new Date().toISOString(),
    ...message
  };
  await appendTranscriptRecord(workspacePath, entry.sessionId, record);
  return record;
}

/**
 * 功能：追加`event` `record`。
 * 输入：`workspacePath`（string）提供工作区 路径。 `entry`（StudentSession）提供entry。 `name`（SessionEventName）提供name。 `detail`（Record<string, unknown>）提供detail。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:recordChatSessionEvent()`、`apps/server/src/modules/conversations/chat-session.service.ts:createNewChatSession()` 调用；内部调用 `randomUUID()`、`toISOString()`、`appendTranscriptRecord()`。
 */
export async function appendEventRecord(
  workspacePath: string,
  entry: StudentSession,
  name: SessionEventName,
  detail: Record<string, unknown>
) {
  const record: SessionEventRecord = {
    type: "event",
    id: randomUUID(),
    sessionId: entry.sessionId,
    sessionKey: entry.sessionKey,
    createdAt: new Date().toISOString(),
    name,
    detail
  };
  await appendTranscriptRecord(workspacePath, entry.sessionId, record);
  return record;
}

/**
 * 功能：读取会话流水 历史记录。
 * 输入：`workspacePath`（string）提供工作区 路径。 `sessionId`（string）提供会话 id。 `limit`提供limit。
 * 输出：返回 Promise<ChatHistoryMessage[]>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:openPiSession()`、`apps/server/src/modules/conversations/chat-session.service.ts:readChatSessionHistory()` 调用；内部调用 `readFile()`、`sessionTranscriptPath()`、`split()`、`parse()`、`randomUUID()`、`toISOString()`。
 */
export async function readTranscriptHistory(workspacePath: string, sessionId: string, limit = 200): Promise<ChatHistoryMessage[]> {
  try {
    const raw = await fs.readFile(sessionTranscriptPath(workspacePath, sessionId), "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    // 统计各类记录数量
    let turnCount = 0, eventCount = 0;
    const messages: ChatHistoryMessage[] = [];
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as { type?: string; role?: string; content?: string; id?: string; createdAt?: string; runId?: string };
        if (record.type === "event") { eventCount++; continue; }
        if (record.type !== "turn") continue;
        if (record.role !== "user" && record.role !== "assistant") continue;
        if (typeof record.content !== "string" || !record.content.trim()) continue;
        turnCount++;
        messages.push({
          id: typeof record.id === "string" ? record.id : randomUUID(),
          role: record.role,
          content: record.content,
          createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date().toISOString(),
          ...(typeof record.runId === "string" ? { runId: record.runId } : {})
        });
      } catch {
        continue;
      }
    }
    const result = messages.slice(-limit);
    logSystem(`transcript ${sessionId.slice(0,8)}: ${lines.length} lines → ${messages.length} turns, ${eventCount} events → returned ${result.length} (limit ${limit})`);
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// 删除指定会话实例的 transcript 文件，用于学生显式重开工程时清掉旧会话视图。
/**
 * 功能：删除会话流水。
 * 输入：`workspacePath`（string）提供工作区 路径。 `sessionId`（string）提供会话 id。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `rm()`、`sessionTranscriptPath()`。
 */
export async function deleteTranscript(workspacePath: string, sessionId: string) {
  await fs.rm(sessionTranscriptPath(workspacePath, sessionId), { force: true });
}
