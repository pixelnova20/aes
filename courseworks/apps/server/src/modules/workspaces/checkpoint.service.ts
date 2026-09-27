/**
 * 文件作用：实现后端“学生工作区”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/workspaces/checkpoint.service.ts`，属于后端“学生工作区”业务模块。
 * 重要函数：`createCheckpoint()` 负责创建检查点；`restoreCheckpoint()` 负责恢复检查点。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "../../infrastructure/prisma/client.js";
import { assertWorkspaceWriteAllowed, getPathDiskUsage } from "./workspace-disk-quota.service.js";
import { assertWorkspaceRoot } from "./safe-path.service.js";

/** 在应用补丁前为工作区工程创建完整检查点。 */
/**
 * 功能：创建检查点。
 * 输入：`workspace`（{ id: string; path: string }）提供工作区。 `agentRunId`（string）提供Agent 运行 id。 `label`（string）提供label。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:applyAgentPatchPlan()` 调用；内部调用 `assertWorkspaceRoot()`、`dirname()`、`replace()`、`toISOString()`、`mkdir()`、`cp()`。
 */
export async function createCheckpoint(workspace: { id: string; path: string }, agentRunId: string, label: string) {
  assertWorkspaceRoot(workspace.path);
  await assertWorkspaceWriteAllowed(workspace.path, await getPathDiskUsage(workspace.path));
  const checkpointRoot = path.join(path.dirname(workspace.path), ".checkpoints");
  const checkpointPath = path.join(checkpointRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-${agentRunId}`);
  await fs.mkdir(checkpointRoot, { recursive: true });
  await fs.cp(workspace.path, checkpointPath, { recursive: true, errorOnExist: false });
  return prisma.checkpoint.create({
    data: {
      agentRunId,
      workspaceId: workspace.id,
      label,
      path: checkpointPath,
      resultMarkdown: `## Checkpoint Created\n\nSaved workspace snapshot at \`${checkpointPath}\`.`
    }
  });
}

/** 恢复属于当前工作区的检查点。 */
/**
 * 功能：恢复检查点。
 * 输入：`checkpointId`（string）提供检查点 id。 `workspace`（{ id: string; path: string }）提供工作区。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:restoreAgentCheckpoint()` 调用；内部调用 `assertWorkspaceRoot()`、`findFirst()`、`dirname()`、`relative()`、`startsWith()`、`isAbsolute()`。
 */
export async function restoreCheckpoint(checkpointId: string, workspace: { id: string; path: string }) {
  assertWorkspaceRoot(workspace.path);
  const checkpoint = await prisma.checkpoint.findFirst({ where: { id: checkpointId, workspaceId: workspace.id } });
  if (!checkpoint) throw new Error("Checkpoint not found.");
  const checkpointRoot = path.join(path.dirname(workspace.path), ".checkpoints");
  const relativeCheckpoint = path.relative(checkpointRoot, checkpoint.path);
  if (relativeCheckpoint.startsWith("..") || path.isAbsolute(relativeCheckpoint)) throw new Error("Invalid checkpoint path.");
  const [currentBytes, checkpointBytes] = await Promise.all([
    getPathDiskUsage(workspace.path),
    getPathDiskUsage(checkpoint.path),
  ]);
  await assertWorkspaceWriteAllowed(workspace.path, Math.max(0, checkpointBytes - currentBytes));
  await fs.rm(workspace.path, { recursive: true, force: true });
  await fs.cp(checkpoint.path, workspace.path, { recursive: true });
  return prisma.checkpoint.update({
    where: { id: checkpoint.id },
    data: { status: "restored", restoredAt: new Date(), resultMarkdown: "## Checkpoint Restored\n\nWorkspace was restored from this checkpoint." }
  });
}
