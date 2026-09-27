/**
 * 文件作用：汇总并导出后端“Coding Agent 与 Pi 适配”业务模块的公共 API。
 * 模块位置：`apps/server/src/modules/coding-agent/index.ts`，属于后端“Coding Agent 与 Pi 适配”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import { PiCodingAgentRuntime } from "./adapters/pi/pi-coding-agent-runtime.js";

export { analyzeBuildError } from "./analyzers/build-error-analyzer.js";
export { analyzeQemuOutput } from "./analyzers/qemu-output-analyzer.js";
export type {
  AgentAiSettings,
  AgentContextUsage,
  AgentImageInput,
  AgentToolInfo,
  CodingAgentRunInput,
  CodingAgentRuntime,
  CompactAgentSessionInput,
} from "./coding-agent-runtime.js";
export {
  buildInboundContext,
  buildOpenFilesContext,
  buildUploadMediaNote,
} from "./inbound-context.js";
export { PiCodingAgentRuntime } from "./adapters/pi/pi-coding-agent-runtime.js";
export {
  readPiSessionContextUsage,
  readPiSessionHistory,
  retainPiSessions,
} from "./adapters/pi/pi-session-store.js";

export const codingAgentRuntime = new PiCodingAgentRuntime();
