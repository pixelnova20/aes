/**
 * 文件作用：管理 Courseworks 自有的工作区 Agent 运行状态。
 * 模块位置：`apps/server/src/modules/execution/workspace-runtime-runner.service.ts`，属于后端“沙箱执行、构建与 QEMU”业务模块。
 */
import fs from "node:fs/promises";
import path from "node:path";

import { assertWorkspaceRoot } from "../workspaces/index.js";

const RUNTIME_STATE_DIRECTORY = [".local", "state", "courseworks", "agent-runtime"];

function runtimeStatePath(workspacePath: string) {
  assertWorkspaceRoot(workspacePath);
  return path.join(path.dirname(path.resolve(workspacePath)), ...RUNTIME_STATE_DIRECTORY);
}

/** 重置 Courseworks 自有的工作区运行状态；不会删除学生工程和聊天流水。 */
export async function resetWorkspaceAgentRuntime(workspacePath: string) {
  await fs.rm(runtimeStatePath(workspacePath), { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(runtimeStatePath(workspacePath), { recursive: true, mode: 0o700 });
}
