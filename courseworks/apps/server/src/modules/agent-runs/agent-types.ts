/**
 * 文件作用：定义后端“Agent 运行记录”业务模块使用的数据结构与类型契约。
 * 模块位置：`apps/server/src/modules/agent-runs/agent-types.ts`，属于后端“Agent 运行记录”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
export type WorkspaceFileSummary = { path: string; size: number; reason: string; contentPreview?: string };
export type WorkspaceContext = { treeMarkdown: string; selectedFiles: WorkspaceFileSummary[] };
export type TaskPlan = { taskSummary: string; relatedFiles: string[]; riskLevel: "low" | "medium" | "high"; planMarkdown: string };
export type DesignResult = { designMarkdown: string; studentExplanationMarkdown: string };
export type PatchResult = { modifiedFiles: string[]; patch: string; studentExplanationMarkdown: string; knownLimitations: string[] };
export type WebSearchResult = { title: string; url: string; snippet: string };
export type AgentIntent = "chat" | "os_build_task" | "workspace_review" | "web_search" | "information" | "unsupported_tool_request";
