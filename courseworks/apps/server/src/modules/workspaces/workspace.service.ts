/**
 * 文件作用：实现后端“学生工作区”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/workspaces/workspace.service.ts`，属于后端“学生工作区”业务模块。
 * 重要函数：`ensureWorkspacePath()` 负责确保工作区 路径；`getReadyWorkspaceForUser()` 负责查询用户工作区并确认其处于 ready 状态；`readDirectoryTree()` 负责读取目录 目录树；`initializeWorkspaceDirectory()` 负责初始化工作区 目录。
 */
import fs from "node:fs/promises";
import path from "node:path";

import { WorkspaceStatus } from "@prisma/client";
import { v4 as uuidv4 } from "uuid";

import { config } from "../../config/index.js";
import { prisma } from "../../infrastructure/prisma/client.js";

// 当前课程模板对应的默认教学目标信息。
export const BUILD_TARGET = {
  osType: "Teaching Monolithic Kernel",
  targetArch: "riscv64",
  targetPlatform: "qemu-virt"
};

/**
 * 功能：确保工作区 路径。
 * 输入：`inputPath`（string）提供结构化输入 路径。 `workspaceRoot`（string）提供工作区 根目录。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/ai-settings/ai-settings-application.service.ts:runDirectAiChat()`、`apps/server/src/application/workspace/workspace-application.service.ts:readWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:createWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:saveWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:uploadWorkspaceFile()` 调用；内部调用 `resolve()`、`relative()`、`startsWith()`、`isAbsolute()`。
 */
export function ensureWorkspacePath(inputPath: string, workspaceRoot: string) {
  // 把用户传入路径解析到 workspace 内，并阻止越界访问。
  const resolved = path.resolve(workspaceRoot, `.${path.sep}${inputPath}`);
  const normalizedRoot = path.resolve(workspaceRoot);
  const relative = path.relative(normalizedRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Invalid path.");
  }
  return resolved;
}

/**
 * 功能：查询用户工作区并确认其处于 ready 状态。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:submitAgentPrompt()`、`apps/server/src/application/agent/agent-application.service.ts:getAgentChatSnapshot()`、`apps/server/src/application/agent/agent-application.service.ts:getAgentChatContextUsage()`、`apps/server/src/application/agent/agent-application.service.ts:startNewAgentChat()`、`apps/server/src/application/agent/agent-application.service.ts:compactAgentChat()` 调用；内部调用 `findUnique()`。
 */
export async function getReadyWorkspaceForUser(userId: string) {
  const workspace = await prisma.workspace.findUnique({ where: { userId } });
  if (!workspace || workspace.status !== WorkspaceStatus.ready) {
    throw new Error("工作区尚未就绪。");
  }
  return workspace;
}

/**
 * 功能：读取目录 目录树。
 * 输入：`root`（string）提供根目录。 `current`提供current。
 * 输出：返回 Promise<FileNode[]>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:getWorkspaceTree()`、`apps/server/src/modules/workspaces/workspace.service.ts:readDirectoryTree()` 调用；内部调用 `readdir()`、`all()`、`sort()`、`startsWith()`、`isSymbolicLink()`、`isDirectory()`。
 */
export async function readDirectoryTree(root: string, current = ""): Promise<FileNode[]> {
  // 前端文件树只展示普通文件和目录，隐藏点目录并跳过符号链接。
  const currentPath = path.join(root, current);
  const entries = await fs.readdir(currentPath, { withFileTypes: true });

  const children = await Promise.all(
    entries
      .filter((entry) => !entry.name.startsWith(".") && !entry.isSymbolicLink())
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .map(async (entry) => {
        const relativePath = path.posix.join(current.replace(/\\/g, "/"), entry.name);
        if (entry.isDirectory()) {
          return {
            name: entry.name,
            path: relativePath,
            type: "directory" as const,
            children: await readDirectoryTree(root, relativePath)
          };
        }

        return {
          name: entry.name,
          path: relativePath,
          type: "file" as const
        };
      })
  );

  return children;
}

/**
 * 功能：初始化工作区 目录。
 * 输入：无显式输入参数。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:initializeStudentWorkspace()` 调用；内部调用 `uuidv4()`、`mkdir()`、`all()`。
 */
export async function initializeWorkspaceDirectory() {
  // 一个学生 workspace 除了 project 目录，还会附带隐藏运行态目录：
  // .local 用来放平台运行状态，.uploads 用来放会话附件暂存。
  const workspaceUuid = uuidv4();
  const workspaceRoot = path.join(config.WORKSPACE_ROOT, workspaceUuid);
  const projectRoot = path.join(workspaceRoot, "project");

  await fs.mkdir(projectRoot, { recursive: true, mode: 0o700 });
  await Promise.all([
    fs.mkdir(path.join(workspaceRoot, ".local", "state", "courseworks"), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(workspaceRoot, ".local", "state", "courseworks", "agent-runtime"), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(workspaceRoot, ".uploads"), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(workspaceRoot, ".eva_history"), { recursive: true, mode: 0o700 })
  ]);

  return {
    workspaceUuid,
    path: projectRoot
  };
}

export type FileNode = {
  // 前端文件树的最小展示结构。
  name: string;
  path: string;
  type: "directory" | "file";
  children?: FileNode[];
};
