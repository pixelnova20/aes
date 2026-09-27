/**
 * 文件作用：实现后端“附件与 Agent 产物”业务模块的数据持久化与读取。
 * 模块位置：`apps/server/src/modules/artifacts/artifact-store.ts`，属于后端“附件与 Agent 产物”业务模块。
 * 重要函数：`sanitizeFileName()` 负责处理`sanitize` 文件 `name`；`ensureArtifactRoots()` 负责确保产物 `roots`；`loadArtifactIndex()` 负责加载产物 `index`；`saveArtifactIndex()` 负责保存产物 `index`；`sha256Bytes()` 负责处理`sha256` `bytes`；`createConsumedArtifacts()` 负责创建`consumed` 产物列表；`createGeneratedArtifact()` 负责创建`generated` 产物；`getGeneratedArtifact()` 负责获取`generated` 产物。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { artifactIndexPath, consumedArtifactsRoot, evaluationArtifactsRoot, generatedArtifactsRoot, sessionArtifactsRoot, uploadsRoot } from "./artifact-paths.js";
import type { ArtifactIndex, ArtifactSessionRef, ConsumedArtifactRecord, GeneratedArtifactRecord, StagedUploadRecord } from "./artifact-types.js";
import { assertWorkspaceWriteAllowed, workspaceHomePath } from "../workspaces/index.js";

/**
 * 功能：处理`sanitize` 文件 `name`。
 * 输入：`name`（string）提供name。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/artifacts/artifact-store.ts:createConsumedArtifacts()`、`apps/server/src/modules/artifacts/artifact-store.ts:createGeneratedArtifact()`、`apps/server/src/modules/artifacts/upload-store.ts:stageUploads()` 调用；内部调用 `pop()`、`split()`、`replace()`。
 */
function sanitizeFileName(name: string) {
  const normalized = name.replace(/\\/g, "/").split("/").pop() ?? "artifact";
  return normalized.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

/**
 * 功能：确保产物 `roots`。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/artifacts/artifact-store.ts:loadArtifactIndex()`、`apps/server/src/modules/artifacts/artifact-store.ts:saveArtifactIndex()` 调用；内部调用 `mkdir()`、`sessionArtifactsRoot()`、`consumedArtifactsRoot()`、`generatedArtifactsRoot()`。
 */
async function ensureArtifactRoots(workspacePath: string) {
  await fs.mkdir(sessionArtifactsRoot(workspacePath), { recursive: true, mode: 0o700 });
  await fs.mkdir(consumedArtifactsRoot(workspacePath), { recursive: true, mode: 0o700 });
  await fs.mkdir(generatedArtifactsRoot(workspacePath), { recursive: true, mode: 0o700 });
  await fs.mkdir(evaluationArtifactsRoot(workspacePath), { recursive: true, mode: 0o700 });
}

/**
 * 功能：加载产物 `index`。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回 Promise<ArtifactIndex>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/artifacts/artifact-store.ts:createConsumedArtifacts()`、`apps/server/src/modules/artifacts/artifact-store.ts:createGeneratedArtifact()`、`apps/server/src/modules/artifacts/artifact-store.ts:getGeneratedArtifact()`、`apps/server/src/modules/artifacts/artifact-store.ts:listGeneratedArtifactsForRun()`、`apps/server/src/modules/artifacts/artifact-store.ts:listGeneratedArtifactsForSession()` 调用；内部调用 `ensureArtifactRoots()`、`parse()`、`readFile()`、`artifactIndexPath()`。
 */
async function loadArtifactIndex(workspacePath: string): Promise<ArtifactIndex> {
  await ensureArtifactRoots(workspacePath);
  try {
    const parsed = JSON.parse(await fs.readFile(artifactIndexPath(workspacePath), "utf8")) as Partial<ArtifactIndex>;
    return {
      version: 2,
      consumed: parsed.consumed && typeof parsed.consumed === "object"
        ? parsed.consumed as Record<string, ConsumedArtifactRecord>
        : {},
      generated: parsed.generated && typeof parsed.generated === "object"
        ? parsed.generated as Record<string, GeneratedArtifactRecord>
        : {},
      archivedFilesBySession: parsed.archivedFilesBySession && typeof parsed.archivedFilesBySession === "object"
        ? parsed.archivedFilesBySession as Record<string, string[]>
        : {},
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 2, consumed: {}, generated: {}, archivedFilesBySession: {} };
    }
    throw error;
  }
}

/**
 * 功能：保存产物 `index`。
 * 输入：`workspacePath`（string）提供工作区 路径。 `index`（ArtifactIndex）提供index。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/modules/artifacts/artifact-store.ts:createConsumedArtifacts()`、`apps/server/src/modules/artifacts/artifact-store.ts:createGeneratedArtifact()`、`apps/server/src/modules/artifacts/artifact-store.ts:deleteArtifactsForSessions()` 调用；内部调用 `ensureArtifactRoots()`、`writeFile()`、`artifactIndexPath()`、`stringify()`、`chmod()`。
 */
async function saveArtifactIndex(workspacePath: string, index: ArtifactIndex) {
  await ensureArtifactRoots(workspacePath);
  await fs.writeFile(artifactIndexPath(workspacePath), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  await fs.chmod(artifactIndexPath(workspacePath), 0o600);
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

// 活动会话只登记附件元数据，文件继续留在 .uploads 供 Agent 和聊天记录读取。
/**
 * 功能：创建`consumed` 产物列表。
 * 输入：`args`（{ workspacePath: string; session: ArtifactSessionRef; turnId?: string; runId?: string; uploads: StagedUploadRecord[]; }）提供args。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/artifacts/upload-store.ts:consumeStagedUploads()` 调用；内部调用 `loadArtifactIndex()`、`randomUUID()`、`sanitizeFileName()`、`evaluationArtifactsRoot()`、`copyVerifiedFile()`。
 */
export async function createConsumedArtifacts(args: {
  workspacePath: string;
  session: ArtifactSessionRef;
  turnId?: string;
  runId?: string;
  uploads: StagedUploadRecord[];
}) {
  if (!args.uploads.length) return [];
  const index = await loadArtifactIndex(args.workspacePath);
  const created: ConsumedArtifactRecord[] = [];
  for (const upload of args.uploads) {
    const artifactId = randomUUID();
    const storedName = upload.storedName;
    const artifact: ConsumedArtifactRecord = {
      id: artifactId,
      kind: "consumed_upload",
      sessionId: args.session.sessionId,
      sessionKey: args.session.sessionKey,
      ...(args.turnId ? { turnId: args.turnId } : {}),
      ...(args.runId ? { runId: args.runId } : {}),
      sourceUploadId: upload.id,
      originalName: upload.originalName,
      storedName,
      artifactPath: upload.absolutePath,
      mimeType: upload.mimeType,
      sizeBytes: upload.sizeBytes,
      sha256: upload.sha256,
      createdAt: new Date().toISOString()
    };
    index.consumed[artifact.id] = artifact;
    created.push(artifact);
  }
  await saveArtifactIndex(args.workspacePath, index);
  return created;
}

function isInside(parent: string, candidate: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Move active-session attachment files into permanent evaluation history during /new. */
export async function archiveConsumedUploads(workspacePath: string) {
  const index = await loadArtifactIndex(workspacePath);
  const activeUploadsRoot = uploadsRoot(workspacePath);
  const archiveRoot = evaluationArtifactsRoot(workspacePath);
  await fs.mkdir(archiveRoot, { recursive: true, mode: 0o700 });
  let changed = false;
  let moved = 0;

  for (const artifact of Object.values(index.consumed)) {
    if (!isInside(activeUploadsRoot, artifact.artifactPath)) continue;
    const destinationPath = path.join(archiveRoot, artifact.storedName);
    const sourceExists = await fs.stat(artifact.artifactPath).then((stat) => stat.isFile()).catch(() => false);
    const destinationExists = await fs.stat(destinationPath).then((stat) => stat.isFile()).catch(() => false);
    if (sourceExists) {
      if (destinationExists) await fs.rm(destinationPath, { force: true });
      await fs.rename(artifact.artifactPath, destinationPath);
      moved += 1;
    } else if (!destinationExists) {
      throw new Error(`Unable to archive attachment ${artifact.originalName}: source file is missing.`);
    }
    artifact.artifactPath = destinationPath;
    changed = true;
  }

  if (changed) await saveArtifactIndex(workspacePath, index);
  return { index, moved };
}

// generated artifact 统一写到隐藏的 session artifact store，避免和 workspace 文件树混在一起。
/**
 * 功能：创建`generated` 产物。
 * 输入：`args`（{ workspacePath: string; session: ArtifactSessionRef; turnId?: string; runId?: string; createdBy: "assistant" | "agent" ）提供args。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/conversations/chat-session.service.ts:createGeneratedArtifactForSession()` 调用；内部调用 `loadArtifactIndex()`、`randomUUID()`、`sanitizeFileName()`、`generatedArtifactsRoot()`、`writeFile()`、`chmod()`。
 */
export async function createGeneratedArtifact(args: {
  workspacePath: string;
  session: ArtifactSessionRef;
  turnId?: string;
  runId?: string;
  createdBy: "assistant" | "agent" | "system";
  displayName: string;
  downloadName: string;
  mimeType?: string;
  contentBytes: Uint8Array;
  summaryMarkdown?: string;
}) {
  await assertWorkspaceWriteAllowed(args.workspacePath, args.contentBytes.byteLength);
  const index = await loadArtifactIndex(args.workspacePath);
  const artifactId = randomUUID();
  const storedName = `${artifactId}-${sanitizeFileName(args.downloadName)}`;
  const destinationPath = path.join(generatedArtifactsRoot(args.workspacePath), storedName);
  await fs.writeFile(destinationPath, args.contentBytes, { mode: 0o600 });
  await fs.chmod(destinationPath, 0o600);
  const artifact: GeneratedArtifactRecord = {
    id: artifactId,
    kind: "generated_file",
    sessionId: args.session.sessionId,
    sessionKey: args.session.sessionKey,
    ...(args.turnId ? { turnId: args.turnId } : {}),
    ...(args.runId ? { runId: args.runId } : {}),
    createdBy: args.createdBy,
    displayName: args.displayName,
    downloadName: args.downloadName,
    storedName,
    artifactPath: destinationPath,
    mimeType: (args.mimeType ?? "").trim(),
    sizeBytes: args.contentBytes.byteLength,
    sha256: sha256Bytes(args.contentBytes),
    ...(args.summaryMarkdown?.trim() ? { summaryMarkdown: args.summaryMarkdown.trim() } : {}),
    createdAt: new Date().toISOString()
  };
  index.generated[artifact.id] = artifact;
  await saveArtifactIndex(args.workspacePath, index);
  return artifact;
}

/**
 * 功能：获取`generated` 产物。
 * 输入：`workspacePath`（string）提供工作区 路径。 `artifactId`（string）提供产物 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:getAgentArtifactDownload()` 调用；内部调用 `loadArtifactIndex()`。
 */
export async function getGeneratedArtifact(workspacePath: string, artifactId: string) {
  const index = await loadArtifactIndex(workspacePath);
  return index.generated[artifactId] ?? null;
}

/** Return an archived user upload by id. The caller must resolve the owning workspace first. */
export async function getConsumedArtifact(workspacePath: string, artifactId: string) {
  const index = await loadArtifactIndex(workspacePath);
  return index.consumed[artifactId] ?? null;
}

/**
 * 功能：列出`generated` 产物列表 `for` 运行。
 * 输入：`workspacePath`（string）提供工作区 路径。 `runId`（string）提供运行 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `loadArtifactIndex()`、`sort()`、`values()`、`localeCompare()`。
 */
export async function listGeneratedArtifactsForRun(workspacePath: string, runId: string) {
  const index = await loadArtifactIndex(workspacePath);
  return Object.values(index.generated)
    .filter((artifact) => artifact.runId === runId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * 功能：列出`generated` 产物列表 `for` 会话。
 * 输入：`workspacePath`（string）提供工作区 路径。 `sessionId`（string）提供会话 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `loadArtifactIndex()`、`sort()`、`values()`、`localeCompare()`。
 */
export async function listGeneratedArtifactsForSession(workspacePath: string, sessionId: string) {
  const index = await loadArtifactIndex(workspacePath);
  return Object.values(index.generated)
    .filter((artifact) => artifact.sessionId === sessionId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * 功能：列出`consumed` 产物列表 `for` 会话。
 * 输入：`workspacePath`（string）提供工作区 路径。 `sessionId`（string）提供会话 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `loadArtifactIndex()`、`sort()`、`values()`、`localeCompare()`。
 */
export async function listConsumedArtifactsForSession(workspacePath: string, sessionId: string) {
  // 会话追问需要能找回之前上传并消费过的附件，因此这里按会话列出稳定归档对象。
  const index = await loadArtifactIndex(workspacePath);
  return Object.values(index.consumed)
    .filter((artifact) => artifact.sessionId === sessionId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

// 生成文件属于会话临时产物；已消费的上传文件属于评价历史，不能因 /new 被删除。
/**
 * 功能：删除产物列表 `for` 会话列表。
 * 输入：`workspacePath`（string）提供工作区 路径。 `sessionIds`（string[]）提供会话 ids。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `loadArtifactIndex()`、`entries()`、`has()`、`rm()`、`saveArtifactIndex()`。
 */
export async function deleteArtifactsForSessions(workspacePath: string, sessionIds: string[]) {
  if (!sessionIds.length) return;
  const sessionIdSet = new Set(sessionIds);
  const index = await loadArtifactIndex(workspacePath);
  for (const [artifactId, artifact] of Object.entries(index.generated)) {
    if (!sessionIdSet.has(artifact.sessionId)) continue;
    await fs.rm(artifact.artifactPath, { force: true });
    delete index.generated[artifactId];
  }
  await saveArtifactIndex(workspacePath, index);
}

/** Record files that were uploaded but never consumed by an Agent Run before /new. */
export async function recordArchivedSessionFiles(
  workspacePath: string,
  sessionId: string,
  artifactPaths: string[],
) {
  if (!artifactPaths.length) return;
  const index = await loadArtifactIndex(workspacePath);
  index.archivedFilesBySession[sessionId] = [
    ...new Set([...(index.archivedFilesBySession[sessionId] ?? []), ...artifactPaths]),
  ];
  await saveArtifactIndex(workspacePath, index);
}

/** Keep attachment and generated-file data for only the active and latest archived sessions. */
export async function retainArtifactsForSessions(
  workspacePath: string,
  retainedSessionIds: string[],
) {
  const retained = new Set(retainedSessionIds);
  const index = await loadArtifactIndex(workspacePath);
  const retainedPaths = new Set<string>();

  for (const artifact of Object.values(index.consumed)) {
    if (retained.has(artifact.sessionId)) retainedPaths.add(path.resolve(artifact.artifactPath));
  }
  for (const artifact of Object.values(index.generated)) {
    if (retained.has(artifact.sessionId)) retainedPaths.add(path.resolve(artifact.artifactPath));
  }
  for (const [sessionId, artifactPaths] of Object.entries(index.archivedFilesBySession)) {
    if (!retained.has(sessionId)) continue;
    for (const artifactPath of artifactPaths) retainedPaths.add(path.resolve(artifactPath));
  }

  const home = workspaceHomePath(workspacePath);
  let removedFiles = 0;
  const removeFile = async (artifactPath: string) => {
    const resolved = path.resolve(artifactPath);
    if (!isInside(home, resolved) || retainedPaths.has(resolved)) return;
    const existed = await fs.stat(resolved).then(() => true).catch(() => false);
    await fs.rm(resolved, { recursive: true, force: true });
    if (existed) removedFiles += 1;
  };

  for (const [artifactId, artifact] of Object.entries(index.consumed)) {
    if (retained.has(artifact.sessionId)) continue;
    await removeFile(artifact.artifactPath);
    delete index.consumed[artifactId];
  }
  for (const [artifactId, artifact] of Object.entries(index.generated)) {
    if (retained.has(artifact.sessionId)) continue;
    await removeFile(artifact.artifactPath);
    delete index.generated[artifactId];
  }
  for (const [sessionId, artifactPaths] of Object.entries(index.archivedFilesBySession)) {
    if (retained.has(sessionId)) continue;
    for (const artifactPath of artifactPaths) await removeFile(artifactPath);
    delete index.archivedFilesBySession[sessionId];
  }

  // Old releases did not associate every archived upload with a session. These roots are
  // Courseworks-owned, so entries with no retained reference are obsolete session data.
  for (const root of [
    evaluationArtifactsRoot(workspacePath),
    consumedArtifactsRoot(workspacePath),
    generatedArtifactsRoot(workspacePath),
  ]) {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      const candidate = path.resolve(root, entry.name);
      const isRetained = [...retainedPaths].some((retainedPath) => (
        isInside(candidate, retainedPath) || isInside(retainedPath, candidate)
      ));
      if (!isRetained) await removeFile(candidate);
    }
  }

  await saveArtifactIndex(workspacePath, index);
  return { removedFiles };
}
