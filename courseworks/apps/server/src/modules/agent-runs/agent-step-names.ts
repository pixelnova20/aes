/**
 * 文件作用：提供后端“Agent 运行记录”业务模块所需的声明和装配。
 * 模块位置：`apps/server/src/modules/agent-runs/agent-step-names.ts`，属于后端“Agent 运行记录”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
export const AGENT_STEP_NAMES = {
  intentClassification: "intent_classification",
  reactThought: "react_thought",
  reactAction: "react_action",
  reactObservation: "react_observation",
  conversationResponse: "conversation_response",
  unsupportedTool: "unsupported_tool",
  webSearch: "web_search",
  workspaceReview: "workspace_review",
  contextCollection: "context_collection",
  taskPlanning: "task_planning",
  designGeneration: "design_generation",
  patchGeneration: "patch_generation",
  patchValidation: "patch_validation",
  waitingUserConfirmation: "waiting_user_confirmation",
  patchApplication: "patch_application",
  buildRun: "build_run",
  qemuSmokeRun: "qemu_smoke_run",
  buildErrorAnalysis: "build_error_analysis",
  qemuOutputAnalysis: "qemu_output_analysis",
  completed: "completed",
  failed: "failed"
} as const;

export type AgentStepName = (typeof AGENT_STEP_NAMES)[keyof typeof AGENT_STEP_NAMES];
