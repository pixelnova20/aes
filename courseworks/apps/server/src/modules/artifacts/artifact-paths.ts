/**
 * 文件作用：实现后端“附件与 Agent 产物”业务模块中的 `uploadsRoot`、`uploadIndexPath`、`sessionArtifactsRoot` 等能力。
 * 模块位置：`apps/server/src/modules/artifacts/artifact-paths.ts`，属于后端“附件与 Agent 产物”业务模块。
 * 重要函数：`uploadsRoot()` 负责处理上传附件列表 根目录；`uploadIndexPath()` 负责上传`index` 路径；`sessionArtifactsRoot()` 负责处理会话 产物列表 根目录；`artifactIndexPath()` 负责处理产物 `index` 路径；`consumedArtifactsRoot()` 负责处理`consumed` 产物列表 根目录；`generatedArtifactsRoot()` 负责处理`generated` 产物列表 根目录。
 */
import path from "node:path";

import {
  courseworksStateRoot,
  workspaceHomePath,
} from "../workspaces/index.js";

const STAGED_UPLOADS_DIRNAME = ".uploads";
const STAGED_UPLOADS_INDEX = "index.json";
const SESSION_ARTIFACTS_DIRNAME = "artifacts";
const SESSION_ARTIFACTS_INDEX = "index.json";
const EVALUATION_HISTORY_DIRNAME = ".eva_history";

export const SANDBOX_UPLOADS_PATH = "/home/runner/.uploads";

/**
 * 功能：处理上传附件列表 根目录。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/artifacts/artifact-paths.ts:uploadIndexPath()`、`apps/server/src/modules/artifacts/upload-store.ts:ensureUploadsRoot()`、`apps/server/src/modules/artifacts/upload-store.ts:stageUploads()`、`apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.test.ts 顶层流程`、`apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:hostToolPath()` 调用；内部调用 `workspaceHomePath()`。
 */
export function uploadsRoot(workspacePath: string) {
  return path.join(workspaceHomePath(workspacePath), STAGED_UPLOADS_DIRNAME);
}

/** 长期评价附件必须与 project 同级，避免被学生项目导出或清空。 */
export function evaluationHistoryRoot(workspacePath: string) {
  return path.join(workspaceHomePath(workspacePath), EVALUATION_HISTORY_DIRNAME);
}

export function evaluationArtifactsRoot(workspacePath: string) {
  return path.join(evaluationHistoryRoot(workspacePath), "artifacts_history");
}

export function pastSessionsRoot(workspacePath: string) {
  return path.join(evaluationHistoryRoot(workspacePath), "past_sessions");
}

/**
 * 功能：上传`index` 路径。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/artifacts/upload-store.ts:loadIndex()`、`apps/server/src/modules/artifacts/upload-store.ts:saveIndex()` 调用；内部调用 `uploadsRoot()`。
 */
export function uploadIndexPath(workspacePath: string) {
  return path.join(uploadsRoot(workspacePath), STAGED_UPLOADS_INDEX);
}

/**
 * 功能：处理会话 产物列表 根目录。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/artifacts/artifact-paths.ts:artifactIndexPath()`、`apps/server/src/modules/artifacts/artifact-paths.ts:consumedArtifactsRoot()`、`apps/server/src/modules/artifacts/artifact-paths.ts:generatedArtifactsRoot()`、`apps/server/src/modules/artifacts/artifact-store.ts:ensureArtifactRoots()` 调用；内部调用 `courseworksStateRoot()`。
 */
export function sessionArtifactsRoot(workspacePath: string) {
  return path.join(courseworksStateRoot(workspacePath), SESSION_ARTIFACTS_DIRNAME);
}

/**
 * 功能：处理产物 `index` 路径。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/artifacts/artifact-store.ts:loadArtifactIndex()`、`apps/server/src/modules/artifacts/artifact-store.ts:saveArtifactIndex()` 调用；内部调用 `sessionArtifactsRoot()`。
 */
export function artifactIndexPath(workspacePath: string) {
  return path.join(sessionArtifactsRoot(workspacePath), SESSION_ARTIFACTS_INDEX);
}

/**
 * 功能：处理`consumed` 产物列表 根目录。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/artifacts/artifact-store.ts:ensureArtifactRoots()`、`apps/server/src/modules/artifacts/artifact-store.ts:createConsumedArtifacts()` 调用；内部调用 `sessionArtifactsRoot()`。
 */
export function consumedArtifactsRoot(workspacePath: string) {
  return path.join(sessionArtifactsRoot(workspacePath), "consumed");
}

/**
 * 功能：处理`generated` 产物列表 根目录。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/artifacts/artifact-store.ts:ensureArtifactRoots()`、`apps/server/src/modules/artifacts/artifact-store.ts:createGeneratedArtifact()` 调用；内部调用 `sessionArtifactsRoot()`。
 */
export function generatedArtifactsRoot(workspacePath: string) {
  return path.join(sessionArtifactsRoot(workspacePath), "generated");
}
