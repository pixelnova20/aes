/**
 * 文件作用：实现后端“课程会话与历史记录”业务模块中的 `configureAgentConversationHistoryReader`、`readAgentConversationHistory` 等能力。
 * 模块位置：`apps/server/src/modules/conversations/conversation-history.port.ts`，属于后端“课程会话与历史记录”业务模块。
 * 重要函数：`configureAgentConversationHistoryReader()` 负责配置Agent `conversation` 历史记录 `reader`；`readAgentConversationHistory()` 负责读取Agent `conversation` 历史记录。
 */
import type { ChatHistoryMessage } from "./session-types.js";

export type ConversationHistoryReader = (
  workspacePath: string,
  cwd: string,
  sessionId: string,
  limit?: number,
) => Promise<ChatHistoryMessage[] | null>;

let agentHistoryReader: ConversationHistoryReader | undefined;

/**
 * 功能：配置Agent `conversation` 历史记录 `reader`。
 * 输入：`reader`（ConversationHistoryReader）提供reader。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/app/app.ts 顶层流程` 调用。
 */
export function configureAgentConversationHistoryReader(
  reader: ConversationHistoryReader,
) {
  agentHistoryReader = reader;
}

/**
 * 功能：读取Agent `conversation` 历史记录。
 * 输入：`workspacePath`（string）提供工作区 路径。 `cwd`（string）提供cwd。 `sessionId`（string）提供会话 id。 `limit`（number）提供limit。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:readChatSessionHistory()` 调用；内部调用 `agentHistoryReader()`。
 */
export async function readAgentConversationHistory(
  workspacePath: string,
  cwd: string,
  sessionId: string,
  limit?: number,
) {
  return agentHistoryReader?.(workspacePath, cwd, sessionId, limit) ?? null;
}
