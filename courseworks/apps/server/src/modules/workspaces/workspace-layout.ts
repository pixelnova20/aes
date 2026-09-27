/**
 * 文件作用：实现后端“学生工作区”业务模块中的 `workspaceHomePath`、`courseworksStateRoot` 等能力。
 * 模块位置：`apps/server/src/modules/workspaces/workspace-layout.ts`，属于后端“学生工作区”业务模块。
 * 重要函数：`workspaceHomePath()` 负责处理工作区 `home` 路径；`courseworksStateRoot()` 负责处理`courseworks` `state` 根目录。
 */
import path from "node:path";

import { assertWorkspaceRoot } from "./safe-path.service.js";

const COURSEWORKS_STATE_DIRECTORY = [".local", "state", "courseworks", "chat-sessions"];

/**
 * 功能：处理工作区 `home` 路径。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/artifacts/artifact-paths.ts:uploadsRoot()`、`apps/server/src/modules/workspaces/workspace-layout.ts:courseworksStateRoot()` 调用；内部调用 `assertWorkspaceRoot()`、`dirname()`、`resolve()`。
 */
export function workspaceHomePath(workspacePath: string) {
  assertWorkspaceRoot(workspacePath);
  return path.dirname(path.resolve(workspacePath));
}

/**
 * 功能：处理`courseworks` `state` 根目录。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/artifacts/artifact-paths.ts:sessionArtifactsRoot()`、`apps/server/src/modules/conversations/session-paths.ts:sessionStateRoot()` 调用；内部调用 `workspaceHomePath()`。
 */
export function courseworksStateRoot(workspacePath: string) {
  return path.join(workspaceHomePath(workspacePath), ...COURSEWORKS_STATE_DIRECTORY);
}
