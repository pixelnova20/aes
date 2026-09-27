/**
 * 文件作用：实现后端“附件与 Agent 产物”业务模块中的 `stageUploads`、`listStagedUploads`、`removeStagedUpload` 等能力。
 * 模块位置：`apps/server/src/modules/artifacts/upload-staging.ts`，属于后端“附件与 Agent 产物”业务模块。
 * 重要函数：`stageUploads()` 负责暂存上传附件列表；`listStagedUploads()` 负责列出`staged` 上传附件列表；`removeStagedUpload()` 负责移除`staged` 上传附件；`consumeStagedUploads()` 负责消费并归档`staged` 上传附件列表；`consumeStagedUploadsForSession()` 负责消费并归档`staged` 上传附件列表 `for` 会话；`discardAllStagedUploads()` 负责丢弃`all` `staged` 上传附件列表；`resolveStagedUploads()` 负责解析并确定`staged` 上传附件列表；`buildUploadContext()` 负责构建上传附件 上下文。
 */
import {
  archiveWorkspaceUploads as archiveWorkspaceUploadsImpl,
  buildUploadContext as buildUploadContextImpl,
  consumeStagedUploads as consumeStagedUploadsImpl,
  discardAllStagedUploads as discardAllStagedUploadsImpl,
  listStagedUploads as listStagedUploadsImpl,
  removeStagedUpload as removeStagedUploadImpl,
  resolveStagedUploads as resolveStagedUploadsImpl,
  stageUploads as stageUploadsImpl,
  stagedUploadContainerPath
} from "./upload-store.js";
import type { ArtifactSessionRef, StagedUploadRecord } from "./artifact-types.js";

export type { StagedUploadRecord };
export { stagedUploadContainerPath };

export async function archiveWorkspaceUploads(workspacePath: string, sessionId?: string) {
  return archiveWorkspaceUploadsImpl(workspacePath, sessionId);
}

// 这个文件只保留兼容层职责，上传与消费逻辑统一由同模块的 upload-store.ts 实现。
/**
 * 功能：暂存上传附件列表。
 * 输入：`workspacePath`（string）提供工作区 路径。 `files`（Array<{ name: string; mimeType?: string; contentBase64: string }>）提供文件列表。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `stageUploadsImpl()`。
 */
export async function stageUploads(workspacePath: string, files: Array<{ name: string; mimeType?: string; contentBase64: string }>) {
  return stageUploadsImpl({
    workspacePath,
    userId: `workspace:${workspacePath}`,
    courseId: "os",
    workspaceId: null,
    files
  });
}

/**
 * 功能：列出`staged` 上传附件列表。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:listWorkspaceUploads()` 调用；内部调用 `listStagedUploadsImpl()`。
 */
export async function listStagedUploads(workspacePath: string) {
  return listStagedUploadsImpl(workspacePath);
}

/**
 * 功能：移除`staged` 上传附件。
 * 输入：`workspacePath`（string）提供工作区 路径。 `uploadId`（string）提供上传附件 id。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:removeWorkspaceUpload()` 调用；内部调用 `removeStagedUploadImpl()`。
 */
export async function removeStagedUpload(workspacePath: string, uploadId: string) {
  return removeStagedUploadImpl(workspacePath, uploadId);
}

/**
 * 功能：消费并归档`staged` 上传附件列表。
 * 输入：`workspacePath`（string）提供工作区 路径。 `uploadIds`（string[]）提供上传附件 ids。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `resolveStagedUploadsImpl()`。
 */
export async function consumeStagedUploads(workspacePath: string, uploadIds: string[]) {
  return resolveStagedUploadsImpl(workspacePath, uploadIds);
}

/**
 * 功能：消费并归档`staged` 上传附件列表 `for` 会话。
 * 输入：`args`（{ workspacePath: string; session: ArtifactSessionRef; turnId?: string; runId?: string; uploadIds: string[]; }）提供args。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:submitAgentPrompt()` 调用；内部调用 `consumeStagedUploadsImpl()`。
 */
export async function consumeStagedUploadsForSession(args: {
  workspacePath: string;
  session: ArtifactSessionRef;
  turnId?: string;
  runId?: string;
  uploadIds: string[];
}) {
  return consumeStagedUploadsImpl(args);
}

/**
 * 功能：丢弃`all` `staged` 上传附件列表。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:startNewAgentChat()` 调用；内部调用 `discardAllStagedUploadsImpl()`。
 */
export async function discardAllStagedUploads(workspacePath: string) {
  return discardAllStagedUploadsImpl(workspacePath);
}

/**
 * 功能：解析并确定`staged` 上传附件列表。
 * 输入：`workspacePath`（string）提供工作区 路径。 `uploadIds`（string[]）提供上传附件 ids。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/artifacts/upload-store.ts:buildUploadContext()` 调用；内部调用 `resolveStagedUploadsImpl()`。
 */
export async function resolveStagedUploads(workspacePath: string, uploadIds: string[]) {
  return resolveStagedUploadsImpl(workspacePath, uploadIds);
}

/**
 * 功能：构建上传附件 上下文。
 * 输入：`workspacePath`（string）提供工作区 路径。 `uploadIds`（string[]）提供上传附件 ids。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `buildUploadContextImpl()`。
 */
export async function buildUploadContext(workspacePath: string, uploadIds: string[]) {
  return buildUploadContextImpl(workspacePath, uploadIds);
}
