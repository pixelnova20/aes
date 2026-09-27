/**
 * 文件作用：汇总并导出后端“沙箱执行、构建与 QEMU”业务模块的公共 API。
 * 模块位置：`apps/server/src/modules/execution/index.ts`，属于后端“沙箱执行、构建与 QEMU”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
export { summarizeBuildLog } from "./build-log.js";
export { runMakeBuild } from "./build-runner.service.js";
export { runWhitelistedMake } from "./process-runner.service.js";
export { summarizeQemuOutput } from "./qemu-output.js";
export {
  cleanupStaleWorkspaceRuntimes,
  createWorkspaceShell,
  getQemuSessionSnapshot,
  getQemuVncStatus,
  getWorkspaceShellLimit,
  getQemuVncTarget,
  listWorkspaceShells,
  resetWorkspaceLabSessions,
  resizeWorkspaceShell,
  sendQemuSessionInput,
  startQemuSession,
  startWorkspaceShell,
  stopQemuSession,
  subscribeQemuSession,
  workspaceOwnsInteractiveSession,
  workspaceOwnsShell,
  type QemuSessionEvent,
  type QemuVncStatus,
  type QemuSessionSnapshot,
  type QemuSessionStatus,
} from "./qemu-session.service.js";
export { runQemuSmoke } from "./qemu-smoke-runner.service.js";
export { runSandboxCommand } from "./sandbox-command.service.js";
export { resetWorkspaceAgentRuntime } from "./workspace-runtime-runner.service.js";
export { attachVncBridge } from "./vnc-bridge.service.js";
export { attachTerminalBridge } from "./terminal-bridge.service.js";
export { startContainerResourceMonitor, stopContainerResourceMonitor } from "./container-resource-monitor.service.js";
export {
  captureGraphicalQemuDisplay,
  getGraphicalQemuSession,
  sendGraphicalQemuInput,
  sendGraphicalQemuKeys,
  startGraphicalQemuSession,
  stopGraphicalQemuSession,
  waitForGraphicalQemuSession,
  type GraphicalQemuSessionSnapshot,
  type QemuDisplayCapture,
} from "./graphical-qemu-session.service.js";
