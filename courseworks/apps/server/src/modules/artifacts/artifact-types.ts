/**
 * 文件作用：定义后端“附件与 Agent 产物”业务模块使用的数据结构与类型契约。
 * 模块位置：`apps/server/src/modules/artifacts/artifact-types.ts`，属于后端“附件与 Agent 产物”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
// Upload 与 Artifact 是两类不同对象：
// staged upload 代表“还未提交给会话”的临时输入；
// artifact 代表“已经进入会话审计链”的正式记录。
export type StagedUploadRecord = {
  id: string;
  userId: string;
  courseId: string;
  workspaceId?: string | null;
  originalName: string;
  storedName: string;
  relativePath: string;
  absolutePath: string;
  stagedPath: string;
  mimeType: string;
  size: number;
  sizeBytes: number;
  sha256: string;
  status: "staged" | "consumed" | "discarded";
  createdAt: string;
  consumedAt?: string;
  consumedByTurnId?: string;
  consumedByRunId?: string;
  discardedAt?: string;
};

export type ArtifactSessionRef = {
  sessionId: string;
  sessionKey: string;
};

export type ConsumedArtifactRecord = {
  id: string;
  kind: "consumed_upload";
  sessionId: string;
  sessionKey: string;
  turnId?: string;
  runId?: string;
  sourceUploadId: string;
  originalName: string;
  storedName: string;
  artifactPath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
};

export type GeneratedArtifactRecord = {
  id: string;
  kind: "generated_file";
  sessionId: string;
  sessionKey: string;
  turnId?: string;
  runId?: string;
  createdBy: "assistant" | "agent" | "system";
  displayName: string;
  downloadName: string;
  storedName: string;
  artifactPath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  summaryMarkdown?: string;
  createdAt: string;
};

export type UploadIndex = {
  version: 2;
  uploads: Record<string, StagedUploadRecord>;
};

export type ArtifactIndex = {
  version: 2;
  consumed: Record<string, ConsumedArtifactRecord>;
  generated: Record<string, GeneratedArtifactRecord>;
  archivedFilesBySession: Record<string, string[]>;
};
