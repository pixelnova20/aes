/**
 * 文件作用：实现后端“附件与 Agent 产物”业务模块的数据持久化与读取。
 * 模块位置：`apps/server/src/modules/artifacts/upload-store.ts`，属于后端“附件与 Agent 产物”业务模块。
 * 重要函数：`sanitizeFileName()` 负责处理`sanitize` 文件 `name`；`ensureUploadsRoot()` 负责确保上传附件列表 根目录；`loadIndex()` 负责加载`index`；`saveIndex()` 负责保存`index`；`sha256Bytes()` 负责处理`sha256` `bytes`；`stagedUploadContainerPath()` 负责处理`staged` 上传附件 `container` 路径；`stageUploads()` 负责暂存上传附件列表；`listStagedUploads()` 负责列出`staged` 上传附件列表。
 */
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  archiveConsumedUploads,
  createConsumedArtifacts,
  recordArchivedSessionFiles,
} from "./artifact-store.js";
import {
  evaluationArtifactsRoot,
  SANDBOX_UPLOADS_PATH,
  uploadIndexPath,
  uploadsRoot,
} from "./artifact-paths.js";
import type { ArtifactSessionRef, StagedUploadRecord, UploadIndex } from "./artifact-types.js";
import { assertWorkspaceRoot, assertWorkspaceWriteAllowed } from "../workspaces/index.js";

const MAX_TEXT_SNIPPET_CHARS = 3_000;
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024;

function imageMimeFromBytes(buffer: Uint8Array): string | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 8 && Buffer.from(buffer.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && Buffer.from(buffer.subarray(0, 3)).toString("ascii") === "GIF") {
    return "image/gif";
  }
  if (buffer.length >= 12 && Buffer.from(buffer.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(buffer.subarray(8, 12)).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

function looksLikeImage(name: string, mimeType: string) {
  return mimeType.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(name);
}

function normalizedImageMime(mimeType: string) {
  return mimeType.toLowerCase() === "image/jpg" ? "image/jpeg" : mimeType.toLowerCase();
}

/**
 * 功能：处理`sanitize` 文件 `name`。
 * 输入：`name`（string）提供name。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/artifacts/artifact-store.ts:createConsumedArtifacts()`、`apps/server/src/modules/artifacts/artifact-store.ts:createGeneratedArtifact()`、`apps/server/src/modules/artifacts/upload-store.ts:stageUploads()` 调用；内部调用 `pop()`、`split()`、`replace()`。
 */
function sanitizeFileName(name: string) {
  const normalized = name.replace(/\\/g, "/").split("/").pop() ?? "attachment";
  return normalized.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "attachment";
}

/**
 * 功能：确保上传附件列表 根目录。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/artifacts/upload-store.ts:loadIndex()`、`apps/server/src/modules/artifacts/upload-store.ts:saveIndex()` 调用；内部调用 `assertWorkspaceRoot()`、`uploadsRoot()`、`mkdir()`、`chmod()`。
 */
async function ensureUploadsRoot(workspacePath: string) {
  assertWorkspaceRoot(workspacePath);
  const root = uploadsRoot(workspacePath);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
}

/**
 * 功能：加载`index`。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回 Promise<UploadIndex>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/artifacts/upload-store.ts:stageUploads()`、`apps/server/src/modules/artifacts/upload-store.ts:listStagedUploads()`、`apps/server/src/modules/artifacts/upload-store.ts:resolveStagedUploads()`、`apps/server/src/modules/artifacts/upload-store.ts:removeStagedUpload()`、`apps/server/src/modules/artifacts/upload-store.ts:discardAllStagedUploads()` 调用；内部调用 `ensureUploadsRoot()`、`parse()`、`readFile()`、`uploadIndexPath()`。
 */
async function loadIndex(workspacePath: string): Promise<UploadIndex> {
  await ensureUploadsRoot(workspacePath);
  try {
    const parsed = JSON.parse(await fs.readFile(uploadIndexPath(workspacePath), "utf8")) as Partial<UploadIndex>;
    return {
      version: 2,
      uploads: parsed.uploads && typeof parsed.uploads === "object"
        ? parsed.uploads as Record<string, StagedUploadRecord>
        : {}
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 2, uploads: {} };
    }
    throw error;
  }
}

/**
 * 功能：保存`index`。
 * 输入：`workspacePath`（string）提供工作区 路径。 `index`（UploadIndex）提供index。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/modules/artifacts/upload-store.ts:stageUploads()`、`apps/server/src/modules/artifacts/upload-store.ts:removeStagedUpload()`、`apps/server/src/modules/artifacts/upload-store.ts:discardAllStagedUploads()`、`apps/server/src/modules/artifacts/upload-store.ts:consumeStagedUploads()` 调用；内部调用 `ensureUploadsRoot()`、`writeFile()`、`uploadIndexPath()`、`stringify()`、`chmod()`。
 */
async function saveIndex(workspacePath: string, index: UploadIndex) {
  await ensureUploadsRoot(workspacePath);
  await fs.writeFile(uploadIndexPath(workspacePath), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(uploadIndexPath(workspacePath), 0o600);
}

/**
 * 功能：处理`sha256` `bytes`。
 * 输入：`content`（Uint8Array）提供content。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/artifacts/artifact-store.ts:createGeneratedArtifact()`、`apps/server/src/modules/artifacts/upload-store.ts:stageUploads()` 调用；内部调用 `digest()`、`update()`、`createHash()`。
 */
function sha256Bytes(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * 功能：处理`staged` 上传附件 `container` 路径。
 * 输入：`upload`（Pick<StagedUploadRecord, "storedName">）提供上传附件。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:submitAgentPrompt()`、`apps/server/src/modules/artifacts/upload-store.ts:buildUploadContext()` 调用。
 */
export function stagedUploadContainerPath(upload: Pick<StagedUploadRecord, "storedName">) {
  return `${SANDBOX_UPLOADS_PATH}/${upload.storedName}`;
}

// stageUploads 只负责把用户文件放进临时输入区，还不让它进入 session。
/**
 * 功能：暂存上传附件列表。
 * 输入：`args`（{ workspacePath: string; userId: string; courseId: string; workspaceId?: string | null; files: Array<{ name: string; mim）提供args。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `loadIndex()`、`randomUUID()`、`sanitizeFileName()`、`uploadsRoot()`、`from()`、`toISOString()`。
 */
export async function stageUploads(args: {
  workspacePath: string;
  userId: string;
  courseId: string;
  workspaceId?: string | null;
  files: Array<{ name: string; mimeType?: string; contentBase64: string }>;
}) {
  const imageFiles = args.files.filter((file) => looksLikeImage(file.name, (file.mimeType ?? "").trim()));
  if (imageFiles.length > MAX_IMAGE_ATTACHMENTS) {
    throw new Error(`每条消息最多可以添加 ${MAX_IMAGE_ATTACHMENTS} 张图片。`);
  }
  let totalImageBytes = 0;
  const preparedFiles = args.files.map((file) => {
    const originalName = file.name.trim() || "attachment";
    const buffer = Buffer.from(file.contentBase64, "base64");
    let mimeType = (file.mimeType ?? "").trim().toLowerCase();
    if (looksLikeImage(originalName, mimeType)) {
      if (buffer.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`图片 ${originalName} 超过 4 MB 限制。`);
      }
      totalImageBytes += buffer.byteLength;
      if (totalImageBytes > MAX_IMAGE_TOTAL_BYTES) {
        throw new Error("附件图片总大小超过 8 MB 限制。");
      }
      const detectedMime = imageMimeFromBytes(buffer);
      if (!detectedMime || (mimeType && normalizedImageMime(mimeType) !== detectedMime)) {
        throw new Error(`不支持或无效的图片附件：${originalName}。`);
      }
      mimeType = detectedMime;
    }
    return { originalName, buffer, mimeType };
  });
  const index = await loadIndex(args.workspacePath);
  await assertWorkspaceWriteAllowed(args.workspacePath, preparedFiles.reduce((sum, file) => sum + file.buffer.byteLength, 0));
  const staged: StagedUploadRecord[] = [];
  for (const prepared of preparedFiles) {
    const uploadId = randomUUID();
    const { originalName, buffer, mimeType } = prepared;
    const storedName = `${uploadId}-${sanitizeFileName(originalName)}`;
    const absolutePath = path.join(uploadsRoot(args.workspacePath), storedName);
    const createdAt = new Date().toISOString();
    await fs.writeFile(absolutePath, buffer, { mode: 0o600 });
    await fs.chmod(absolutePath, 0o600);
    const record: StagedUploadRecord = {
      id: uploadId,
      userId: args.userId,
      courseId: args.courseId,
      workspaceId: args.workspaceId ?? null,
      originalName,
      storedName,
      relativePath: `.uploads/${storedName}`,
      absolutePath,
      stagedPath: absolutePath,
      mimeType,
      size: buffer.byteLength,
      sizeBytes: buffer.byteLength,
      sha256: sha256Bytes(buffer),
      status: "staged",
      createdAt
    };
    index.uploads[uploadId] = record;
    staged.push(record);
  }
  await saveIndex(args.workspacePath, index);
  return staged.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/**
 * 功能：列出`staged` 上传附件列表。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:listWorkspaceUploads()` 调用；内部调用 `loadIndex()`、`sort()`、`values()`、`localeCompare()`。
 */
export async function listStagedUploads(workspacePath: string) {
  const index = await loadIndex(workspacePath);
  return Object.values(index.uploads)
    .filter((upload) => upload.status === "staged")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/**
 * 功能：解析并确定`staged` 上传附件列表。
 * 输入：`workspacePath`（string）提供工作区 路径。 `uploadIds`（string[]）提供上传附件 ids。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/artifacts/upload-store.ts:buildUploadContext()` 调用；内部调用 `loadIndex()`。
 */
export async function resolveStagedUploads(workspacePath: string, uploadIds: string[]) {
  const index = await loadIndex(workspacePath);
  return uploadIds
    .map((uploadId) => index.uploads[uploadId])
    .filter((upload): upload is StagedUploadRecord => Boolean(upload && upload.status === "staged"));
}

/**
 * 功能：移除`staged` 上传附件。
 * 输入：`workspacePath`（string）提供工作区 路径。 `uploadId`（string）提供上传附件 id。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:removeWorkspaceUpload()` 调用；内部调用 `loadIndex()`、`toISOString()`、`rm()`、`saveIndex()`。
 */
export async function removeStagedUpload(workspacePath: string, uploadId: string) {
  const index = await loadIndex(workspacePath);
  const existing = index.uploads[uploadId];
  if (!existing || existing.status !== "staged") return false;
  index.uploads[uploadId] = {
    ...existing,
    status: "discarded",
    discardedAt: new Date().toISOString()
  };
  await saveIndex(workspacePath, index);
  return true;
}

/**
 * 功能：丢弃`all` `staged` 上传附件列表。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:startNewAgentChat()` 调用；内部调用 `loadIndex()`、`values()`、`toISOString()`、`catch()`、`rm()`、`saveIndex()`。
 */
export async function discardAllStagedUploads(workspacePath: string) {
  const index = await loadIndex(workspacePath);
  const uploads = Object.values(index.uploads).filter((upload) => upload.status === "staged");
  if (!uploads.length) return;
  const discardedAt = new Date().toISOString();
  for (const upload of uploads) {
    index.uploads[upload.id] = {
      ...upload,
      status: "discarded",
      discardedAt
    };
  }
  await saveIndex(workspacePath, index);
}

/** Archive every retained upload on /new, including files removed before submission. */
export async function archiveWorkspaceUploads(workspacePath: string, sessionId?: string) {
  const index = await loadIndex(workspacePath);
  const consumed = await archiveConsumedUploads(workspacePath);
  const sourceRoot = uploadsRoot(workspacePath);
  const destinationRoot = evaluationArtifactsRoot(workspacePath);
  await fs.mkdir(destinationRoot, { recursive: true, mode: 0o700 });
  let moved = consumed.moved;
  const movedPaths: string[] = [];

  for (const entry of await fs.readdir(sourceRoot, { withFileTypes: true })) {
    if (entry.name === path.basename(uploadIndexPath(workspacePath))) continue;
    const sourcePath = path.join(sourceRoot, entry.name);
    const destinationPath = path.join(destinationRoot, entry.name);
    if (entry.isDirectory()) {
      await fs.rename(sourcePath, destinationPath);
    } else {
      const destinationExists = await fs.stat(destinationPath).then((stat) => stat.isFile()).catch(() => false);
      if (destinationExists) await fs.rm(destinationPath, { force: true });
      await fs.rename(sourcePath, destinationPath);
    }
    movedPaths.push(destinationPath);
    moved += 1;
  }

  if (sessionId) await recordArchivedSessionFiles(workspacePath, sessionId, movedPaths);
  await saveIndex(workspacePath, { version: 2, uploads: {} });
  return { moved };
}

// consumeStagedUploads 是 upload -> consumed artifact 的正式转换入口。
/**
 * 功能：消费并归档`staged` 上传附件列表。
 * 输入：`args`（{ workspacePath: string; session: ArtifactSessionRef; turnId?: string; runId?: string; uploadIds: string[]; }）提供args。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `loadIndex()`、`toISOString()`、`saveIndex()`、`createConsumedArtifacts()`。
 */
export async function consumeStagedUploads(args: {
  workspacePath: string;
  session: ArtifactSessionRef;
  turnId?: string;
  runId?: string;
  uploadIds: string[];
}) {
  const index = await loadIndex(args.workspacePath);
  const uploads = args.uploadIds
    .map((uploadId) => index.uploads[uploadId])
    .filter((upload): upload is StagedUploadRecord => Boolean(upload && upload.status === "staged"));
  if (!uploads.length) return { uploads: [], artifacts: [] };
  const consumedAt = new Date().toISOString();
  for (const upload of uploads) {
    index.uploads[upload.id] = {
      ...upload,
      status: "consumed",
      consumedAt,
      ...(args.turnId ? { consumedByTurnId: args.turnId } : {}),
      ...(args.runId ? { consumedByRunId: args.runId } : {})
    };
  }
  await saveIndex(args.workspacePath, index);
  const artifacts = await createConsumedArtifacts({
    workspacePath: args.workspacePath,
    session: args.session,
    turnId: args.turnId,
    runId: args.runId,
    uploads
  });
  return { uploads: uploads.map((upload) => index.uploads[upload.id]), artifacts };
}

/**
 * 功能：判断是否为`likely` `text` 上传附件。
 * 输入：`upload`（StagedUploadRecord）提供上传附件。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/artifacts/upload-store.ts:buildUploadContext()` 调用；内部调用 `startsWith()`、`test()`。
 */
function isLikelyTextUpload(upload: StagedUploadRecord) {
  if (upload.mimeType.startsWith("text/")) return true;
  return /\.(c|h|cpp|hpp|s|S|ld|mk|make|txt|md|json|yaml|yml|toml|csv|ts|tsx|js|jsx|py|java|rs|go|sh)$/i.test(upload.originalName);
}

/**
 * 功能：构建上传附件 上下文。
 * 输入：`workspacePath`（string）提供工作区 路径。 `uploadIds`（string[]）提供上传附件 ids。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `resolveStagedUploads()`、`stagedUploadContainerPath()`、`isLikelyTextUpload()`、`readFile()`。
 */
export async function buildUploadContext(workspacePath: string, uploadIds: string[]) {
  const uploads = await resolveStagedUploads(workspacePath, uploadIds);
  if (!uploads.length) return "";
  const sections: string[] = [
    "## Uploaded attachments",
    "",
    "这些文件是本轮聊天上传的会话附件，不是 workspace 文件。只有当用户明确要求把附件写入 workspace、或需要拿附件与 workspace 代码对比时，才应该调用 workspace 工具；如果附件预览已经足够回答用户问题，应直接基于附件内容回答。"
  ];
  for (const upload of uploads) {
    sections.push(`- ${upload.originalName}`);
    sections.push(`  Path: \`${stagedUploadContainerPath(upload)}\``);
    sections.push(`  Size: ${upload.sizeBytes} bytes`);
    if (!isLikelyTextUpload(upload)) continue;
    try {
      const content = await fs.readFile(upload.absolutePath, "utf8");
      sections.push("", `### Attachment preview: ${upload.originalName}`, "```text", content.slice(0, MAX_TEXT_SNIPPET_CHARS), "```", "");
    } catch {
      sections.push("");
    }
  }
  return sections.join("\n").trim();
}
