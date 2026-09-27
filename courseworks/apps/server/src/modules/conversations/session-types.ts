/**
 * 文件作用：定义后端“课程会话与历史记录”业务模块使用的数据结构与类型契约。
 * 模块位置：`apps/server/src/modules/conversations/session-types.ts`，属于后端“课程会话与历史记录”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
// 会话归属信息用于生成稳定的 sessionKey，确保“同一门课的同一学生”
// 在重复登录、页面刷新和普通追问时都能落到同一个逻辑会话上。
export type SessionOwner = {
  courseId: string;
  userId: string;
  workspaceId?: string | null;
};

// sessionKey 表示逻辑会话身份；sessionId 表示某次具体会话实例。
export type StudentSessionKey = {
  scope: "course_student";
  courseId: string;
  userId: string;
  value: string;
};

export type StudentSessionStatus = "active" | "superseded";

// StudentSession 是会话元数据摘要，供 active session 解析、列表展示和回写使用。
export type StudentSession = {
  sessionId: string;
  sessionKey: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  lastPromptPreview?: string;
  status: StudentSessionStatus;
  closedAt?: string;
  closeReason?: string;
};

export type SessionCreatedReason = "auto_first_login" | "user_slash_new";

export type SessionCreatedRecord = {
  type: "session.created";
  id: string;
  sessionId: string;
  sessionKey: string;
  createdAt: string;
  cwd: string;
  title: string;
  reason: SessionCreatedReason;
};

export type SessionEventName =
  | "session.superseded"
  | "workspace.reset"
  | "artifact.consumed"
  | "artifact.generated"
  | "artifact.downloaded"
  | "attachments.consume_failed"
  | "session.compacted";

export type SessionEventRecord = {
  type: "event";
  id: string;
  sessionId: string;
  sessionKey: string;
  createdAt: string;
  name: SessionEventName;
  detail: Record<string, unknown>;
};

export type StudentTurn = {
  type: "turn";
  id: string;
  sessionId: string;
  sessionKey: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  runId?: string;
  attachmentRefs?: Array<{
    id: string;
    originalName: string;
    mimeType: string;
    size: number;
  }>;
};

export type TranscriptRecord = SessionCreatedRecord | SessionEventRecord | StudentTurn;

export type ChatHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  runId?: string;
  attachments?: ChatHistoryAttachment[];
};

export type ChatHistoryAttachment = {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
};

export type SessionStoreState = {
  version: 3;
  currentSessionId: string | null;
  activeSessionKeys: Record<string, string | null>;
  sessions: Record<string, StudentSession>;
};
