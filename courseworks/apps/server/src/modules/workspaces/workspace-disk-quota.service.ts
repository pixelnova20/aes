/** 计算并检查 workspace 的宿主机磁盘占用，避免 Docker 内存限制掩盖磁盘填满风险。 */
import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../../config/index.js";
import { workspaceHomePath } from "./workspace-layout.js";
import { assertWorkspaceRoot } from "./safe-path.service.js";

export type DiskQuotaState = {
  usageBytes: number;
  softLimitBytes: number;
  hardLimitBytes: number;
  softExceeded: boolean;
  hardExceeded: boolean;
};

export const DISK_QUOTA_ERROR_MESSAGE = "磁盘存储空间不够：学生目录已达到 250 MB 上限，请删除不需要的文件后重试。";

async function measure(entryPath: string): Promise<number> {
  let stat;
  try { stat = await fs.lstat(entryPath); } catch { return 0; }
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = stat.size;
  let entries;
  try { entries = await fs.readdir(entryPath, { withFileTypes: true }); } catch { return total; }
  for (const entry of entries) total += await measure(path.join(entryPath, entry.name));
  return total;
}

export async function getPathDiskUsage(entryPath: string) {
  return measure(path.resolve(entryPath));
}

export async function getWorkspaceDiskQuota(workspacePath: string): Promise<DiskQuotaState> {
  assertWorkspaceRoot(workspacePath);
  // 配额属于学生，而不只是 project；附件、会话和评价历史都位于 UUID 目录内。
  const usageBytes = await measure(workspaceHomePath(workspacePath));
  return {
    usageBytes,
    softLimitBytes: config.WORKSPACE_DISK_SOFT_LIMIT_BYTES,
    hardLimitBytes: config.WORKSPACE_DISK_HARD_LIMIT_BYTES,
    softExceeded: usageBytes >= config.WORKSPACE_DISK_SOFT_LIMIT_BYTES,
    hardExceeded: usageBytes >= config.WORKSPACE_DISK_HARD_LIMIT_BYTES,
  };
}

export async function assertWorkspaceExecutionAllowed(workspacePath: string) {
  const quota = await getWorkspaceDiskQuota(workspacePath);
  if (quota.hardExceeded) throw new Error(DISK_QUOTA_ERROR_MESSAGE);
  if (quota.softExceeded) console.warn(`[workspace-quota] workspace is above the soft limit: ${workspacePath} (${quota.usageBytes} bytes)`);
  return quota;
}

export async function assertWorkspaceWriteAllowed(workspacePath: string, additionalBytes = 0) {
  const quota = await getWorkspaceDiskQuota(workspacePath);
  if (quota.usageBytes + Math.max(0, additionalBytes) > quota.hardLimitBytes) {
    throw new Error(DISK_QUOTA_ERROR_MESSAGE);
  }
  if (quota.softExceeded || quota.usageBytes + Math.max(0, additionalBytes) >= quota.softLimitBytes) {
    console.warn(`[workspace-quota] workspace is above the soft limit: ${workspacePath} (${quota.usageBytes} bytes)`);
  }
  return quota;
}

export const workspaceDiskQuotaTestSupport = { measure };
