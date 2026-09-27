/**
 * 文件作用：实现后端“Coding Agent 与 Pi 适配”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/coding-agent/coding-agent-runtime.ts`，属于后端“Coding Agent 与 Pi 适配”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import type { StudentSession } from "../conversations/index.js";
import type { ReasoningEffort } from "../ai-settings/index.js";
import type { WorkspaceMutation } from "../evaluation-history/index.js";

export type AgentAiSettings = {
  apiKey: string;
  baseUrl: string;
  model: string;
  profileName?: string;
  profileSource?: "personal" | "class";
  temperature?: number;
  contextWindowTokens?: number | null;
  reasoningEffort?: ReasoningEffort;
};

export type AgentImageInput = {
  data: string;
  mimeType: string;
};

export type CodingAgentRunInput = {
  runId: string;
  userId: string;
  workspaceId?: string;
  workspacePath: string;
  cwd: string;
  prompt: string;
  images?: AgentImageInput[];
  aiSettings: AgentAiSettings;
  chatSession: StudentSession;
  mode?: "work" | "review";
  systemPrompt?: string;
  readableWorkspaceRoots?: string[];
  email?: string;
  onMutation?: (mutation: WorkspaceMutation) => Promise<void>;
  onTokenUsage?: (tokens: number) => Promise<boolean>;
};

export type CompactAgentSessionInput = {
  workspacePath: string;
  cwd: string;
  chatSession: StudentSession;
  mode?: "work" | "review";
  systemPrompt?: string;
  readableWorkspaceRoots?: string[];
  aiSettings: AgentAiSettings;
  onTokenUsage?: (tokens: number) => Promise<void>;
};

export type AgentToolInfo = {
  name: string;
  description: string;
};

export type AgentContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

export interface CodingAgentRuntime {
  run(input: CodingAgentRunInput): Promise<string>;
  abort(runId: string): Promise<void>;
  compact(input: CompactAgentSessionInput): Promise<{
    compacted: boolean;
    summary?: string;
    beforeTurns?: number;
    afterTurns?: number;
  }>;
  getContextUsage(sessionId: string): AgentContextUsage | undefined;
  listTools(mode?: "work" | "review"): readonly AgentToolInfo[];
}
