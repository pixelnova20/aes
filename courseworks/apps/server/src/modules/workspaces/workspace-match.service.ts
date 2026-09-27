/**
 * 文件作用：维护学生工作区根目录下的账户与工作区 UUID 映射文件。
 * 模块位置：`apps/server/src/modules/workspaces/workspace-match.service.ts`，属于后端“学生工作区”业务模块。
 * 重要函数：`syncWorkspaceMatchFile()` 负责从数据库重建 `match.txt`。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

import { config } from "../../config/index.js";
import { prisma } from "../../infrastructure/prisma/client.js";

type WorkspaceMatchClient = Pick<PrismaClient, "workspace">;

let pendingSync = Promise.resolve();

async function writeWorkspaceMatchFile(workspaceRoot: string, client: WorkspaceMatchClient) {
  const workspaces = await client.workspace.findMany({
    select: {
      workspaceUuid: true,
      user: { select: { email: true } },
    },
    orderBy: { workspaceUuid: "asc" },
  });

  const lines: string[] = [];
  for (const workspace of workspaces) {
    const workspacePath = path.join(workspaceRoot, workspace.workspaceUuid);
    try {
      const stat = await fs.stat(workspacePath);
      if (!stat.isDirectory()) continue;
    } catch {
      // 数据库记录可能暂时早于目录创建；下次同步时会再次检查。
      continue;
    }
    const legacyStatePath = path.join(workspacePath, ".local", "state", "ai-os-builder");
    let isLegacy = false;
    try {
      isLegacy = (await fs.stat(legacyStatePath)).isDirectory();
    } catch {
      // 没有旧版运行态目录时按当前 Courseworks 工作区记录。
    }
    lines.push(`${workspace.user.email}\t${workspace.workspaceUuid}${isLegacy ? "\tlegacy-ai-os-builder" : ""}`);
  }

  const matchPath = path.join(workspaceRoot, "match.txt");
  const temporaryPath = path.join(workspaceRoot, `.match.txt.${process.pid}.${randomUUID()}.tmp`);
  const content = lines.length ? `${lines.join("\n")}\n` : "";
  try {
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(temporaryPath, 0o600);
    await fs.rename(temporaryPath, matchPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

/**
 * 功能：从数据库重建学生账户与工作区 UUID 的映射文件。
 * 输入：`options`（可选的工作区根目录和 Prisma 客户端，测试时使用）。
 * 输出：返回该操作的完成状态；异步处理完成后 `match.txt` 与现有工作区记录一致。旧版目录在第三列标记为 `legacy-ai-os-builder`。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:initializeStudentWorkspace()`、`apps/server/src/app/server.ts` 调用；内部调用 `findMany()`、`stat()`、`writeFile()`、`rename()`。
 */
export function syncWorkspaceMatchFile(options: {
  workspaceRoot?: string;
  client?: WorkspaceMatchClient;
} = {}) {
  const nextSync = pendingSync.then(() => writeWorkspaceMatchFile(
    options.workspaceRoot ?? config.WORKSPACE_ROOT,
    options.client ?? prisma,
  ));
  pendingSync = nextSync.catch(() => undefined);
  return nextSync;
}
