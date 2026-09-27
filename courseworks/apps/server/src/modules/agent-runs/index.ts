/**
 * 文件作用：汇总并导出后端“Agent 运行记录”业务模块的公共 API。
 * 模块位置：`apps/server/src/modules/agent-runs/index.ts`，属于后端“Agent 运行记录”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
export {
  ACTIVE_AGENT_RUN_STATUSES,
  getAgentRunDetail,
  getOwnedAgentRun,
} from "./agent-run.service.js";
export {
  PrismaAgentRunStore,
  type AgentRunStore,
  type AgentTraceInput,
} from "./agent-run.store.js";
export { AGENT_STEP_NAMES, type AgentStepName } from "./agent-step-names.js";
export { addTrace } from "./agent-trace.service.js";
export type {
  AgentIntent,
  DesignResult,
  PatchResult,
  TaskPlan,
  WebSearchResult,
  WorkspaceContext,
  WorkspaceFileSummary,
} from "./agent-types.js";
