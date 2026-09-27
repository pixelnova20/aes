/**
 * 文件作用：汇总并导出后端“课程会话与历史记录”业务模块的公共 API。
 * 模块位置：`apps/server/src/modules/conversations/index.ts`，属于后端“课程会话与历史记录”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
export {
  type ChatSessionEntry,
  createGeneratedArtifactForSession,
  createNewChatSession,
  ensureActiveChatSession,
  getActiveChatSessionSnapshot,
  attachConsumedArtifactsToHistory,
  listChatSessions,
  readChatSessionHistory,
  retainChatSessions,
  recordAttachmentConsumption,
  recordChatSessionEvent,
} from "./chat-session.service.js";
export {
  configureAgentConversationHistoryReader,
  readAgentConversationHistory,
  type ConversationHistoryReader,
} from "./conversation-history.port.js";
export { DEFAULT_COURSE_ID } from "./session-key.js";
export {
  sessionStateRoot,
  sessionStorePath,
  sessionTranscriptPath,
  workspaceHomePath,
} from "./session-paths.js";
export type {
  ChatHistoryMessage,
  SessionOwner,
  StudentSession,
} from "./session-types.js";
export {
  appendEventRecord,
  appendTurnRecord,
  ensureTranscriptExists,
  readTranscriptHistory,
  writeSessionCreatedRecord,
} from "./transcript-store.js";
