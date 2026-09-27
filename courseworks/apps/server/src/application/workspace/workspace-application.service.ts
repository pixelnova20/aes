/**
 * 文件作用：编排后端“工作台”应用编排层用例及其跨模块调用。
 * 模块位置：`apps/server/src/application/workspace/workspace-application.service.ts`，属于后端“工作台”应用编排层。
 * 重要函数：`normalizeRelativePath()` 负责规范化`relative` 路径；`assertNotWorkspaceRoot()` 负责断言并校验`not` 工作区 根目录；`touchWorkspace()` 负责更新工作区；`getReadyWorkspace()` 负责获取`ready` 工作区；`getWorkspaceStatus()` 负责获取工作区 状态；`initializeStudentWorkspace()` 负责初始化`student` 工作区；`getWorkspaceTree()` 负责获取工作区 目录树；`importStudentWorkspace()` 负责处理`import` `student` 工作区。
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

import { WorkspaceStatus } from "@prisma/client";

import { prisma } from "../../infrastructure/prisma/client.js";
import {
  listStagedUploads,
  removeStagedUpload,
  stageUploadsForOwner,
} from "../../modules/artifacts/index.js";
import { DEFAULT_COURSE_ID } from "../../modules/conversations/index.js";
import { recordWorkspaceActivityEvent } from "../../modules/evaluation-history/index.js";
import {
  createWorkspaceShell,
  getQemuSessionSnapshot,
  getQemuVncStatus,
  getWorkspaceShellLimit,
  listWorkspaceShells,
  resetWorkspaceLabSessions,
  resizeWorkspaceShell,
  sendQemuSessionInput,
  startWorkspaceShell,
  stopQemuSession,
  workspaceOwnsShell,
  workspaceOwnsInteractiveSession,
} from "../../modules/execution/index.js";
import {
  BUILD_TARGET,
  assertNoSymlinkPath,
  assertWorkspaceWriteAllowed,
  createWorkspaceExportZip,
  ensureSafeParentDirectory,
  ensureWorkspacePath,
  importWorkspaceArchive,
  initializeWorkspaceDirectory,
  readDirectoryTree,
  syncWorkspaceMatchFile,
  type WorkspaceImportArgs,
} from "../../modules/workspaces/index.js";

export type WorkspaceUploadInput = {
  name: string;
  mimeType?: string;
  contentBase64: string;
};

/**
 * 功能：规范化`relative` 路径。
 * 输入：`value`（string）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:assertNotWorkspaceRoot()`、`apps/server/src/application/workspace/workspace-application.service.ts:readWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:createWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:saveWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:uploadWorkspaceFile()` 调用；内部调用 `replace()`。
 */
function normalizeRelativePath(value: string) {
  return value.replace(/\\/g, "/");
}

/**
 * 功能：断言并校验`not` 工作区 根目录。
 * 输入：`relativePath`（string）提供relative 路径。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:createWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:saveWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:uploadWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:deleteWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:createWorkspaceDirectory()` 调用；内部调用 `replace()`、`normalizeRelativePath()`。
 */
function assertNotWorkspaceRoot(relativePath: string) {
  const normalized = normalizeRelativePath(relativePath)
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  if (!normalized || normalized === ".") {
    throw new Error("不能通过此接口修改工作区根目录。");
  }
}

/**
 * 功能：更新工作区。
 * 输入：`workspaceId`（string）提供工作区 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:importStudentWorkspace()`、`apps/server/src/application/workspace/workspace-application.service.ts:createWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:saveWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:uploadWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:deleteWorkspaceFile()` 调用；内部调用 `update()`。
 */
async function touchWorkspace(workspaceId: string) {
  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { updatedAt: new Date() },
  });
}

async function sha256File(filePath: string) {
  try {
    return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  } catch {
    return undefined;
  }
}

async function recordWorkspaceMutation(args: {
  workspaceId: string;
  actorUserId: string;
  eventType: "file.create" | "file.write" | "file.delete" | "directory.create" | "directory.delete" | "workspace.import" | "upload.stage" | "upload.discard";
  relativePath?: string;
  beforeSha256?: string;
  afterSha256?: string;
  metadata?: Record<string, string | number | boolean | null>;
}) {
  try {
    await recordWorkspaceActivityEvent({
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      source: "workspace-api",
      mutation: {
        eventType: args.eventType,
        path: args.relativePath ?? ".",
        beforeSha256: args.beforeSha256,
        afterSha256: args.afterSha256,
        metadata: args.metadata,
      },
    });
  } catch (error) {
    console.error("[workspace-activity]", error instanceof Error ? error.message : error);
  }
}

/**
 * 功能：获取`ready` 工作区。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:getWorkspaceTree()`、`apps/server/src/application/workspace/workspace-application.service.ts:importStudentWorkspace()`、`apps/server/src/application/workspace/workspace-application.service.ts:exportStudentWorkspace()`、`apps/server/src/application/workspace/workspace-application.service.ts:readWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:createWorkspaceFile()` 调用；内部调用 `findUnique()`。
 */
async function getReadyWorkspace(userId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { userId } });
  if (!workspace || workspace.status !== WorkspaceStatus.ready) {
    throw new Error("工作区尚未就绪。");
  }
  return workspace;
}

/**
 * 功能：获取工作区 状态。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `findUnique()`。
 */
export async function getWorkspaceStatus(userId: string) {
  return (
    await prisma.workspace.findUnique({ where: { userId } })
  ) ?? { status: WorkspaceStatus.not_created };
}

/**
 * 功能：初始化`student` 工作区。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `findUnique()`、`initializeWorkspaceDirectory()`、`update()`、`create()`。
 */
export async function initializeStudentWorkspace(userId: string) {
  const existing = await prisma.workspace.findUnique({ where: { userId } });
  if (existing?.status === WorkspaceStatus.ready) {
    await syncWorkspaceMatchFile();
    return { workspace: existing, initialized: false };
  }

  const created = await initializeWorkspaceDirectory();
  const data = {
    workspaceUuid: created.workspaceUuid,
    path: created.path,
    status: WorkspaceStatus.ready,
    osType: BUILD_TARGET.osType,
    targetArch: BUILD_TARGET.targetArch,
    targetPlatform: BUILD_TARGET.targetPlatform,
  };
  const workspace = existing
    ? prisma.workspace.update({ where: { userId }, data })
    : prisma.workspace.create({ data: { userId, ...data } });
  const initializedWorkspace = await workspace;
  await syncWorkspaceMatchFile();
  return { workspace: initializedWorkspace, initialized: true };
}

/**
 * 功能：获取工作区 目录树。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`readDirectoryTree()`。
 */
export async function getWorkspaceTree(userId: string) {
  const workspace = await getReadyWorkspace(userId);
  return readDirectoryTree(workspace.path);
}

/**
 * 功能：处理`import` `student` 工作区。
 * 输入：`userId`（string）提供用户 id。 `input`（Omit<WorkspaceImportArgs, "workspacePath">）提供当前操作所需的结构化输入。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`importWorkspaceArchive()`、`touchWorkspace()`。
 */
export async function importStudentWorkspace(
  userId: string,
  input: Omit<WorkspaceImportArgs, "workspacePath">,
) {
  const workspace = await getReadyWorkspace(userId);
  const summary = await importWorkspaceArchive({
    workspacePath: workspace.path,
    ...input,
  });
  await recordWorkspaceMutation({
    workspaceId: workspace.id,
    actorUserId: userId,
    eventType: "workspace.import",
    metadata: { archiveName: input.originalName, writtenCount: summary.writtenCount, mode: summary.mode },
  });
  await touchWorkspace(workspace.id);
  return summary;
}

/**
 * 功能：处理`export` `student` 工作区。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`createWorkspaceExportZip()`。
 */
export async function exportStudentWorkspace(userId: string) {
  const workspace = await getReadyWorkspace(userId);
  return createWorkspaceExportZip(workspace.path, workspace.workspaceUuid);
}

/**
 * 功能：读取工作区 文件。
 * 输入：`userId`（string）提供用户 id。 `relativePath`（string）提供relative 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`assertNoSymlinkPath()`、`ensureWorkspacePath()`、`stat()`、`isFile()`、`normalizeRelativePath()`。
 */
export async function readWorkspaceFile(userId: string, relativePath: string) {
  const workspace = await getReadyWorkspace(userId);
  await assertNoSymlinkPath(workspace.path, relativePath);
  const fullPath = ensureWorkspacePath(relativePath, workspace.path);
  const stat = await fs.stat(fullPath);
  if (!stat.isFile()) throw new Error("该路径不是文件。");
  return {
    path: normalizeRelativePath(relativePath),
    content: await fs.readFile(fullPath, "utf8"),
  };
}

/**
 * 功能：创建工作区 文件。
 * 输入：`userId`（string）提供用户 id。 `relativePath`（string）提供relative 路径。 `content`（string）提供content。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`assertNotWorkspaceRoot()`、`assertNoSymlinkPath()`、`ensureSafeParentDirectory()`、`ensureWorkspacePath()`、`writeFile()`。
 */
export async function createWorkspaceFile(
  userId: string,
  relativePath: string,
  content: string,
) {
  const workspace = await getReadyWorkspace(userId);
  assertNotWorkspaceRoot(relativePath);
  await assertNoSymlinkPath(workspace.path, relativePath);
  await ensureSafeParentDirectory(workspace.path, relativePath);
  const fullPath = ensureWorkspacePath(relativePath, workspace.path);
  await assertWorkspaceWriteAllowed(workspace.path, Buffer.byteLength(content, "utf8"));
  await fs.writeFile(fullPath, content, { encoding: "utf8", flag: "wx" });
  await recordWorkspaceMutation({ workspaceId: workspace.id, actorUserId: userId, eventType: "file.create", relativePath: normalizeRelativePath(relativePath), afterSha256: await sha256File(fullPath) });
  await touchWorkspace(workspace.id);
  return { message: "文件已创建。", path: normalizeRelativePath(relativePath) };
}

/**
 * 功能：保存工作区 文件。
 * 输入：`userId`（string）提供用户 id。 `relativePath`（string）提供relative 路径。 `content`（string）提供content。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`assertNotWorkspaceRoot()`、`assertNoSymlinkPath()`、`ensureWorkspacePath()`、`stat()`、`isFile()`。
 */
export async function saveWorkspaceFile(
  userId: string,
  relativePath: string,
  content: string,
) {
  const workspace = await getReadyWorkspace(userId);
  assertNotWorkspaceRoot(relativePath);
  await assertNoSymlinkPath(workspace.path, relativePath);
  const fullPath = ensureWorkspacePath(relativePath, workspace.path);
  const stat = await fs.stat(fullPath);
  if (!stat.isFile()) throw new Error("该路径不是文件。");
  await assertWorkspaceWriteAllowed(workspace.path, Math.max(0, Buffer.byteLength(content, "utf8") - stat.size));
  const beforeSha256 = await sha256File(fullPath);
  await fs.writeFile(fullPath, content, "utf8");
  await recordWorkspaceMutation({ workspaceId: workspace.id, actorUserId: userId, eventType: "file.write", relativePath: normalizeRelativePath(relativePath), beforeSha256, afterSha256: await sha256File(fullPath) });
  await touchWorkspace(workspace.id);
  return { message: "文件已保存。", path: normalizeRelativePath(relativePath) };
}

/**
 * 功能：上传工作区 文件。
 * 输入：`userId`（string）提供用户 id。 `relativePath`（string）提供relative 路径。 `contentBase64`（string）提供content base64。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`assertNotWorkspaceRoot()`、`assertNoSymlinkPath()`、`ensureSafeParentDirectory()`、`ensureWorkspacePath()`、`stat()`。
 */
export async function uploadWorkspaceFile(
  userId: string,
  relativePath: string,
  contentBase64: string,
) {
  const workspace = await getReadyWorkspace(userId);
  assertNotWorkspaceRoot(relativePath);
  await assertNoSymlinkPath(workspace.path, relativePath);
  await ensureSafeParentDirectory(workspace.path, relativePath);
  const fullPath = ensureWorkspacePath(relativePath, workspace.path);
  try {
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) throw new Error("该路径不是文件。");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const beforeSha256 = await sha256File(fullPath);
  const content = Buffer.from(contentBase64, "base64");
  let currentSize = 0;
  try { currentSize = (await fs.stat(fullPath)).size; } catch { /* new file */ }
  await assertWorkspaceWriteAllowed(workspace.path, Math.max(0, content.byteLength - currentSize));
  await fs.writeFile(fullPath, content);
  await recordWorkspaceMutation({ workspaceId: workspace.id, actorUserId: userId, eventType: "file.write", relativePath: normalizeRelativePath(relativePath), beforeSha256, afterSha256: await sha256File(fullPath) });
  await touchWorkspace(workspace.id);
  return { message: "文件已上传。", path: normalizeRelativePath(relativePath) };
}

/**
 * 功能：列出工作区 上传附件列表。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`listStagedUploads()`。
 */
export async function listWorkspaceUploads(userId: string) {
  const workspace = await getReadyWorkspace(userId);
  return listStagedUploads(workspace.path);
}

/**
 * 功能：暂存工作区 上传附件列表。
 * 输入：`userId`（string）提供用户 id。 `files`（WorkspaceUploadInput[]）提供文件列表。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`stageUploadsForOwner()`。
 */
export async function stageWorkspaceUploads(userId: string, files: WorkspaceUploadInput[]) {
  const workspace = await getReadyWorkspace(userId);
  const result = await stageUploadsForOwner({
    workspacePath: workspace.path,
    userId,
    courseId: DEFAULT_COURSE_ID,
    workspaceId: workspace.id,
    files,
  });
  for (const upload of result) {
    await recordWorkspaceMutation({ workspaceId: workspace.id, actorUserId: userId, eventType: "upload.stage", relativePath: `.uploads/${upload.storedName}`, metadata: { originalName: upload.originalName, sizeBytes: upload.sizeBytes, sha256: upload.sha256 } });
  }
  return result;
}

/**
 * 功能：移除工作区 上传附件。
 * 输入：`userId`（string）提供用户 id。 `uploadId`（string）提供上传附件 id。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`removeStagedUpload()`。
 */
export async function removeWorkspaceUpload(userId: string, uploadId: string) {
  const workspace = await getReadyWorkspace(userId);
  const result = await removeStagedUpload(workspace.path, uploadId);
  await recordWorkspaceMutation({ workspaceId: workspace.id, actorUserId: userId, eventType: "upload.discard", relativePath: `.uploads/${uploadId}` });
  return result;
}

/**
 * 功能：删除工作区 文件。
 * 输入：`userId`（string）提供用户 id。 `relativePath`（string）提供relative 路径。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`assertNotWorkspaceRoot()`、`assertNoSymlinkPath()`、`ensureWorkspacePath()`、`stat()`、`isFile()`。
 */
export async function deleteWorkspaceFile(userId: string, relativePath: string) {
  const workspace = await getReadyWorkspace(userId);
  assertNotWorkspaceRoot(relativePath);
  await assertNoSymlinkPath(workspace.path, relativePath);
  const fullPath = ensureWorkspacePath(relativePath, workspace.path);
  const stat = await fs.stat(fullPath);
  if (!stat.isFile()) throw new Error("该路径不是文件。");
  const beforeSha256 = await sha256File(fullPath);
  await fs.unlink(fullPath);
  await recordWorkspaceMutation({ workspaceId: workspace.id, actorUserId: userId, eventType: "file.delete", relativePath: normalizeRelativePath(relativePath), beforeSha256 });
  await touchWorkspace(workspace.id);
  return { message: "文件已删除。", path: normalizeRelativePath(relativePath) };
}

/**
 * 功能：创建工作区 目录。
 * 输入：`userId`（string）提供用户 id。 `relativePath`（string）提供relative 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`assertNotWorkspaceRoot()`、`assertNoSymlinkPath()`、`ensureWorkspacePath()`、`mkdir()`、`touchWorkspace()`。
 */
export async function createWorkspaceDirectory(userId: string, relativePath: string) {
  const workspace = await getReadyWorkspace(userId);
  assertNotWorkspaceRoot(relativePath);
  await assertNoSymlinkPath(workspace.path, relativePath);
  const fullPath = ensureWorkspacePath(relativePath, workspace.path);
  await fs.mkdir(fullPath, { recursive: true });
  await recordWorkspaceMutation({ workspaceId: workspace.id, actorUserId: userId, eventType: "directory.create", relativePath: normalizeRelativePath(relativePath) });
  await touchWorkspace(workspace.id);
  return { message: "目录已创建。", path: normalizeRelativePath(relativePath) };
}

/**
 * 功能：删除工作区 目录。
 * 输入：`userId`（string）提供用户 id。 `relativePath`（string）提供relative 路径。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`assertNotWorkspaceRoot()`、`assertNoSymlinkPath()`、`ensureWorkspacePath()`、`stat()`、`isDirectory()`。
 */
export async function deleteWorkspaceDirectory(userId: string, relativePath: string) {
  const workspace = await getReadyWorkspace(userId);
  assertNotWorkspaceRoot(relativePath);
  await assertNoSymlinkPath(workspace.path, relativePath);
  const fullPath = ensureWorkspacePath(relativePath, workspace.path);
  const stat = await fs.stat(fullPath);
  if (!stat.isDirectory()) throw new Error("该路径不是目录。");
  await fs.rm(fullPath, { recursive: true, force: false });
  await recordWorkspaceMutation({ workspaceId: workspace.id, actorUserId: userId, eventType: "directory.delete", relativePath: normalizeRelativePath(relativePath) });
  await touchWorkspace(workspace.id);
  return { message: "目录已删除。", path: normalizeRelativePath(relativePath) };
}

/**
 * 功能：获取工作区 构建结果 目标。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用。
 */
export function getWorkspaceBuildTarget() {
  return {
    selected: BUILD_TARGET,
    comingSoon: [
      "Host-assisted Proxy Kernel",
      "Embedded RTOS-style Kernel",
      "arm64-qemu-virt",
      "x86_64-qemu",
    ],
  };
}

/**
 * 功能：获取工作区 实验环境。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`getQemuSessionSnapshot()`、`listWorkspaceShells()`。
 */
export async function getWorkspaceLab(userId: string) {
  const workspace = await getReadyWorkspace(userId);
  return {
    workspace: { id: workspace.id, workspaceUuid: workspace.workspaceUuid },
    session: getQemuSessionSnapshot(workspace.id),
    shells: listWorkspaceShells(workspace.id),
    limits: { maxShells: getWorkspaceShellLimit() },
  };
}

export async function getWorkspaceLabVncStatus(userId: string, sessionId: string) {
  const workspace = await getReadyWorkspace(userId);
  if (!workspaceOwnsInteractiveSession(workspace.id, sessionId)) {
    throw new Error("交互式工作区会话不存在。");
  }
  return getQemuVncStatus(sessionId);
}

/** 清理普通 OS Lab 的旧运行态，并为本次页面访问创建唯一的新 Bash。 */
export async function resetWorkspaceLab(userId: string) {
  const workspace = await getReadyWorkspace(userId);
  resetWorkspaceLabSessions(workspace.id);
  const session = await createWorkspaceShell(workspace.id, workspace.path);
  return {
    workspace: { id: workspace.id, workspaceUuid: workspace.workspaceUuid },
    session,
    limits: { maxShells: getWorkspaceShellLimit() },
  };
}

/**
 * 功能：创建工作区 实验环境 终端会话。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`createWorkspaceShell()`。
 */
export async function createWorkspaceLabShell(userId: string) {
  const workspace = await getReadyWorkspace(userId);
  return createWorkspaceShell(workspace.id, workspace.path);
}

/**
 * 功能：获取`owned` 工作区 终端会话。
 * 输入：`userId`（string）提供用户 id。 `sessionId`（string）提供会话 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:sendWorkspaceLabShellInput()`、`apps/server/src/application/workspace/workspace-application.service.ts:resizeWorkspaceLabShell()`、`apps/server/src/application/workspace/workspace-application.service.ts:closeWorkspaceLabShell()` 调用；内部调用 `getReadyWorkspace()`、`workspaceOwnsShell()`。
 */
async function getOwnedWorkspaceShell(userId: string, sessionId: string) {
  const workspace = await getReadyWorkspace(userId);
  if (!workspaceOwnsShell(workspace.id, sessionId)) {
    throw new Error("工作区终端不存在。");
  }
  return workspace;
}

/**
 * 功能：发送工作区 实验环境 终端会话 结构化输入。
 * 输入：`userId`（string）提供用户 id。 `sessionId`（string）提供会话 id。 `input`（string）提供当前操作所需的结构化输入。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getOwnedWorkspaceShell()`、`sendQemuSessionInput()`。
 */
export async function sendWorkspaceLabShellInput(
  userId: string,
  sessionId: string,
  input: string,
) {
  await getOwnedWorkspaceShell(userId, sessionId);
  return sendQemuSessionInput(sessionId, input);
}

/**
 * 功能：调整大小工作区 实验环境 终端会话。
 * 输入：`userId`（string）提供用户 id。 `sessionId`（string）提供会话 id。 `columns`（number）提供columns。 `rows`（number）提供rows。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getOwnedWorkspaceShell()`、`resizeWorkspaceShell()`。
 */
export async function resizeWorkspaceLabShell(
  userId: string,
  sessionId: string,
  columns: number,
  rows: number,
) {
  await getOwnedWorkspaceShell(userId, sessionId);
  return resizeWorkspaceShell(sessionId, columns, rows);
}

/**
 * 功能：关闭工作区 实验环境 终端会话。
 * 输入：`userId`（string）提供用户 id。 `sessionId`（string）提供会话 id。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getOwnedWorkspaceShell()`、`stopQemuSession()`。
 */
export async function closeWorkspaceLabShell(userId: string, sessionId: string) {
  await getOwnedWorkspaceShell(userId, sessionId);
  return stopQemuSession(sessionId);
}

/**
 * 功能：启动工作区 实验环境。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`startWorkspaceShell()`。
 */
export async function startWorkspaceLab(userId: string) {
  const workspace = await getReadyWorkspace(userId);
  return startWorkspaceShell(workspace.id, workspace.path);
}

/**
 * 功能：发送工作区 实验环境 结构化输入。
 * 输入：`userId`（string）提供用户 id。 `input`（string）提供当前操作所需的结构化输入。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`sendQemuSessionInput()`。
 */
export async function sendWorkspaceLabInput(userId: string, input: string) {
  const workspace = await getReadyWorkspace(userId);
  return sendQemuSessionInput(workspace.id, input);
}

/**
 * 功能：停止工作区 实验环境。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspace()`、`stopQemuSession()`。
 */
export async function stopWorkspaceLab(userId: string) {
  const workspace = await getReadyWorkspace(userId);
  return stopQemuSession(workspace.id);
}
