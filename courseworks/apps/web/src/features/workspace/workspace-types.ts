/**
 * 文件作用：定义前端“工作台”功能模块使用的数据结构与类型契约。
 * 模块位置：`apps/web/src/features/workspace/workspace-types.ts`，属于前端“工作台”功能模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import type { AgentRunTraceDetail } from "./agent-run-activity";

export type ViewKey = "explorer" | "runs" | "class";
export type WorkbenchTheme = "dark" | "light";
export type OpenFile = { path: string; content: string; dirty: boolean };
export type ChatEntry = {
  id: string;
  role: "user" | "assistant";
  content: string;
  thinking?: string;
  activity?: string | AgentRunTraceDetail[];
  runId?: string;
  chinese?: boolean;
  pending?: boolean;
  attachments?: ChatAttachment[];
};
export type ChatAttachment = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string;
};
export type ChatArtifactDownload = { artifactId: string; fileName: string };
export type AgentContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};
export type ChatSessionSnapshot = {
  currentSessionId: string | null;
  session: { sessionId: string; title: string; updatedAt: string } | null;
  sessions: Array<{
    sessionId: string;
    title: string;
    updatedAt: string;
    turnCount?: number;
    messageCount?: number;
    status: string;
  }>;
  history: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    createdAt: string;
    runId?: string;
    attachments?: ChatAttachment[];
  }>;
  contextUsage: AgentContextUsage | null;
};
export type StagedUpload = {
  id: string;
  originalName: string;
  storedName: string;
  relativePath: string;
  absolutePath: string;
  mimeType: string;
  size: number;
  createdAt: string;
  previewUrl?: string;
};
export type AiProviderForm = {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: string;
  contextWindowTokens: string;
  reasoningEffort: ReasoningEffort;
};
export type ReasoningEffort =
  | "default"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type AiModelProfile = {
  providerName?: string | null;
  modelName: string;
  contextWindowTokens: number;
  effectiveInputTokens?: number | null;
  sourceNote?: string | null;
  family?: string;
  reasoning?: boolean;
  reasoningEffortOptions?: ReasoningEffort[];
};
export type WorkspaceImportSummary = {
  archiveName: string;
  archiveKind: "zip" | "tar.gz" | "tar.bz2";
  mode: "archive-only" | "extract";
  targetPath: string;
  overwritePolicy: "fail" | "merge" | "overwrite";
  extracted: boolean;
  writtenFiles: string[];
  writtenCount: number;
  skippedFiles: string[];
  skippedCount: number;
  conflictFiles: string[];
  conflictCount: number;
  entryCount: number;
  totalBytes: number;
};
export type AgentTraceEventView = {
  id?: string;
  stepName?: string;
  stepStatus?: string;
  inputSummaryMarkdown?: string | null;
  outputSummaryMarkdown?: string | null;
  errorMarkdown?: string | null;
  debugMarkdown?: string | null;
};
export type AgentRunView = {
  id: string;
  status: string;
  createdAt?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  courseTaskSessionId?: string | null;
  prompt?: string | null;
  taskSummary?: string | null;
  currentStep?: string | null;
  finishedAt?: string | null;
  finalAnswerMarkdown?: string | null;
  responseMarkdown?: string | null;
  errorMessage?: string | null;
  traceEvents?: AgentTraceEventView[] | null;
  patchPlans?: Array<{ status: string }>;
  buildRuns?: Array<{ status: string }>;
  qemuSmokeRuns?: Array<{ status: string }>;
};
export type AiSettingsView = {
  configured: boolean;
  baseUrl?: string;
  apiKeyConfigured?: boolean;
  apiKeyMasked?: string;
  model?: string;
  temperature?: number;
  contextWindowTokens?: number;
  reasoningEffort?: ReasoningEffort;
  reasoningEffortOptions?: ReasoningEffort[];
};
export type ClassProgressView = {
  classes: Array<{
    id: string;
    code: string;
    className: string | null;
    students: Array<{
      id: string;
      email: string;
      workspaceStatus: string;
      aiProviderConfigured: boolean;
    }>;
  }>;
};
export type CourseTaskView = {
  title?: string | null;
  subtasks?: Array<{
    title?: string | null;
    lastBuildStatus?: string | null;
    lastQemuStatus?: string | null;
  }>;
};
