/**
 * 文件作用：定义前端共享能力层使用的数据结构与类型契约。
 * 模块位置：`apps/web/src/shared/types.ts`，属于前端共享能力层。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
// 前端与后端交互时最常用的共享数据结构。
export type UserRole = "super_admin" | "teacher" | "ta" | "student";

export type AuthUser = {
  id: string;
  email: string;
  name?: string | null;
  studentNo?: string | null;
  role: UserRole;
  courseName?: string | null;
  className?: string | null;
  workspaceStatus?: string;
};

export type Workspace = {
  id: string;
  userId: string;
  workspaceUuid: string;
  path: string;
  status: "not_created" | "initializing" | "ready" | "failed";
  osType: string | null;
  targetArch: string | null;
  targetPlatform: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FileNode = {
  // Explorer 面板里的一棵文件树节点。
  name: string;
  path: string;
  type: "directory" | "file";
  children?: FileNode[];
};
