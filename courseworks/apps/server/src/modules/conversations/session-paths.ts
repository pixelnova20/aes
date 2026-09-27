/**
 * 文件作用：实现后端“课程会话与历史记录”业务模块中的 `sessionStateRoot`、`sessionStorePath`、`sessionTranscriptPath` 等能力。
 * 模块位置：`apps/server/src/modules/conversations/session-paths.ts`，属于后端“课程会话与历史记录”业务模块。
 * 重要函数：`sessionStateRoot()` 负责处理会话 `state` 根目录；`sessionStorePath()` 负责处理会话 `store` 路径；`sessionTranscriptPath()` 负责处理会话 会话流水 路径。
 */
import path from "node:path";

import {
  courseworksStateRoot,
  workspaceHomePath,
} from "../workspaces/index.js";

const CHAT_SESSION_STORE_FILE = "sessions.json";

// 会话数据必须位于工作区之外但又与该学生环境同属一个平台侧目录，
// 这样既不会污染源码目录，也便于部署时统一备份与清理。
export { workspaceHomePath };

/**
 * 功能：处理会话 `state` 根目录。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:createPiSession()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:piSessionRoot()`、`apps/server/src/modules/conversations/session-paths.ts:sessionStorePath()`、`apps/server/src/modules/conversations/session-paths.ts:sessionTranscriptPath()`、`apps/server/src/modules/conversations/session-store.ts:ensureSessionStateRoot()` 调用；内部调用 `courseworksStateRoot()`。
 */
export function sessionStateRoot(workspacePath: string) {
  return courseworksStateRoot(workspacePath);
}

/**
 * 功能：处理会话 `store` 路径。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/conversations/session-store.ts:loadSessionStore()`、`apps/server/src/modules/conversations/session-store.ts:saveSessionStore()` 调用；内部调用 `sessionStateRoot()`。
 */
export function sessionStorePath(workspacePath: string) {
  return path.join(sessionStateRoot(workspacePath), CHAT_SESSION_STORE_FILE);
}

/**
 * 功能：处理会话 会话流水 路径。
 * 输入：`workspacePath`（string）提供工作区 路径。 `sessionId`（string）提供会话 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/conversations/transcript-store.ts:appendTranscriptRecord()`、`apps/server/src/modules/conversations/transcript-store.ts:writeSessionCreatedRecord()`、`apps/server/src/modules/conversations/transcript-store.ts:ensureTranscriptExists()`、`apps/server/src/modules/conversations/transcript-store.ts:readTranscriptHistory()`、`apps/server/src/modules/conversations/transcript-store.ts:deleteTranscript()` 调用；内部调用 `sessionStateRoot()`。
 */
export function sessionTranscriptPath(workspacePath: string, sessionId: string) {
  return path.join(sessionStateRoot(workspacePath), `${sessionId}.jsonl`);
}
