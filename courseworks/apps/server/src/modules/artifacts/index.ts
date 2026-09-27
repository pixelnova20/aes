/**
 * 文件作用：汇总并导出后端“附件与 Agent 产物”业务模块的公共 API。
 * 模块位置：`apps/server/src/modules/artifacts/index.ts`，属于后端“附件与 Agent 产物”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
export {
  artifactIndexPath,
  consumedArtifactsRoot,
  evaluationArtifactsRoot,
  evaluationHistoryRoot,
  generatedArtifactsRoot,
  pastSessionsRoot,
  SANDBOX_UPLOADS_PATH,
  sessionArtifactsRoot,
  uploadIndexPath,
  uploadsRoot,
} from "./artifact-paths.js";
export {
  createConsumedArtifacts,
  archiveConsumedUploads,
  createGeneratedArtifact,
  deleteArtifactsForSessions,
  getConsumedArtifact,
  getGeneratedArtifact,
  listConsumedArtifactsForSession,
  listGeneratedArtifactsForRun,
  listGeneratedArtifactsForSession,
  recordArchivedSessionFiles,
  retainArtifactsForSessions,
} from "./artifact-store.js";
export type {
  ArtifactIndex,
  ArtifactSessionRef,
  ConsumedArtifactRecord,
  GeneratedArtifactRecord,
  StagedUploadRecord,
  UploadIndex,
} from "./artifact-types.js";
export {
  buildUploadContext,
  archiveWorkspaceUploads,
  consumeStagedUploads,
  consumeStagedUploadsForSession,
  discardAllStagedUploads,
  listStagedUploads,
  removeStagedUpload,
  resolveStagedUploads,
  stageUploads,
  stagedUploadContainerPath,
} from "./upload-staging.js";
export { stageUploads as stageUploadsForOwner } from "./upload-store.js";
