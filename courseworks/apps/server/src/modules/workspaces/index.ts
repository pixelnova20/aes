/**
 * 文件作用：汇总并导出后端“学生工作区”业务模块的公共 API。
 * 模块位置：`apps/server/src/modules/workspaces/index.ts`，属于后端“学生工作区”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
export { createCheckpoint, restoreCheckpoint } from "./checkpoint.service.js";
export {
  createWorkspaceExportZip,
  importWorkspaceArchive,
  type WorkspaceArchiveKind,
  type WorkspaceExportResult,
  type WorkspaceImportArgs,
  type WorkspaceImportMode,
  type WorkspaceImportSummary,
  type WorkspaceOverwritePolicy,
} from "./import-export.service.js";
export { applyWorkspacePatch } from "./patch-apply.service.js";
export {
  assertNoSymlinkPath,
  assertWorkspaceRoot,
  ensureSafeParentDirectory,
  safePathResolve,
} from "./safe-path.service.js";
export {
  applyCurrentMarkdownSavePlan,
  applyWorkspaceDeletePlan,
  applyWorkspaceStructurePlan,
  clearWorkspaceContents,
  extractCurrentMarkdownSavePlan,
  extractWorkspaceAttachmentSavePlan,
  extractWorkspaceDeletePlan,
  extractWorkspaceFileExportPlan,
  extractWorkspaceStructurePlan,
  isWorkspaceClearRequest,
  shouldUseDeterministicWorkspaceScaffold,
  type WorkspaceAttachmentSavePlan,
  type WorkspaceClearResult,
  type WorkspaceCurrentMarkdownSavePlan,
  type WorkspaceCurrentMarkdownSaveResult,
  type WorkspaceDeletePlan,
  type WorkspaceDeleteResult,
  type WorkspaceFileExportPlan,
  type WorkspaceStructurePlan,
  type WorkspaceStructureResult,
} from "./scaffold.service.js";
export { courseworksStateRoot, workspaceHomePath } from "./workspace-layout.js";
export {
  assertWorkspaceExecutionAllowed,
  assertWorkspaceWriteAllowed,
  DISK_QUOTA_ERROR_MESSAGE,
  getPathDiskUsage,
  getWorkspaceDiskQuota,
} from "./workspace-disk-quota.service.js";
export {
  BUILD_TARGET,
  ensureWorkspacePath,
  getReadyWorkspaceForUser,
  initializeWorkspaceDirectory,
  readDirectoryTree,
  type FileNode,
} from "./workspace.service.js";
export { syncWorkspaceMatchFile } from "./workspace-match.service.js";
