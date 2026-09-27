/**
 * 文件作用：实现后端“学生工作区”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/workspaces/safe-path.service.ts`，属于后端“学生工作区”业务模块。
 * 重要函数：`assertInsideRoot()` 负责断言并校验`inside` 根目录；`assertWorkspaceRoot()` 负责断言并校验工作区 根目录；`safePathResolve()` 负责处理`safe` 路径 `resolve`；`assertNoSymlinkPath()` 负责断言并校验`no` `symlink` 路径；`ensureSafeParentDirectory()` 负责确保`safe` `parent` 目录。
 */
import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../../config/index.js";

const BLOCKED_SEGMENTS = new Set([".git", ".env", ".checkpoints", "node_modules"]);

/**
 * 功能：断言并校验`inside` 根目录。
 * 输入：`root`（string）提供根目录。 `candidate`（string）提供candidate。 `message`（string）提供消息。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/workspaces/safe-path.service.ts:assertWorkspaceRoot()`、`apps/server/src/modules/workspaces/safe-path.service.ts:safePathResolve()` 调用；内部调用 `resolve()`、`relative()`、`startsWith()`、`isAbsolute()`。
 */
function assertInsideRoot(root: string, candidate: string, message: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(message);
  }
}

/** 确认工作区路径属于配置的学生工作区根目录。 */
/**
 * 功能：断言并校验工作区 根目录。
 * 输入：`workspaceRoot`（string）提供工作区 根目录。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/artifacts/upload-store.ts:ensureUploadsRoot()`、`apps/server/src/modules/execution/process-runner.service.ts:runWhitelistedMake()`、`apps/server/src/modules/execution/qemu-session.service.ts:startInteractiveSession()`、`apps/server/src/modules/execution/sandbox-command.service.ts:runSandboxCommand()`、`apps/server/src/modules/execution/workspace-runtime-runner.service.ts:runtimeStatePath()` 调用；内部调用 `assertInsideRoot()`。
 */
export function assertWorkspaceRoot(workspaceRoot: string) {
  assertInsideRoot(config.WORKSPACE_ROOT, workspaceRoot, "Workspace is outside the configured workspace root.");
}

/** 解析用户提供的路径，并确保结果始终位于 WORKSPACE_ROOT 内。 */
/**
 * 功能：处理`safe` 路径 `resolve`。
 * 输入：`workspaceRoot`（string）提供工作区 根目录。 `inputPath`提供结构化输入 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:workspaceRelativePath()`、`apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:validateWorkspacePath()`、`apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:validateReadablePath()`、`apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:writeFile()`、`apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:mkdir()` 调用；内部调用 `assertWorkspaceRoot()`、`replace()`、`resolve()`、`assertInsideRoot()`、`some()`、`split()`。
 */
export function safePathResolve(workspaceRoot: string, inputPath = ".") {
  assertWorkspaceRoot(workspaceRoot);
  const normalizedInput = inputPath.replace(/\\/g, "/");
  const resolved = path.resolve(workspaceRoot, `.${path.sep}${normalizedInput}`);
  // 允许 ../.uploads 等路径，只要最终落在 WORKSPACE_ROOT 内
  assertInsideRoot(config.WORKSPACE_ROOT, resolved, "Path is outside the workspace root.");
  if (path.relative(path.resolve(workspaceRoot), resolved).split("/").some((segment) => BLOCKED_SEGMENTS.has(segment))) {
    throw new Error("Blocked workspace path.");
  }
  return resolved;
}

/** 在补丁写入或删除前拒绝包含符号链接的父路径和目标。 */
/**
 * 功能：断言并校验`no` `symlink` 路径。
 * 输入：`workspaceRoot`（string）提供工作区 根目录。 `relativePath`（string）提供relative 路径。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/application/ai-settings/ai-settings-application.service.ts:runDirectAiChat()`、`apps/server/src/application/workspace/workspace-application.service.ts:readWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:createWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:saveWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:uploadWorkspaceFile()` 调用；内部调用 `safePathResolve()`、`resolve()`、`replace()`、`relative()`、`split()`、`lstat()`。
 */
export async function assertNoSymlinkPath(workspaceRoot: string, relativePath: string) {
  const resolved = safePathResolve(workspaceRoot, relativePath);
  const root = path.resolve(workspaceRoot);
  const relative = path.relative(root, resolved).replace(/\\/g, "/");
  const segments = relative.split("/").filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Patch target crosses a symbolic link: ${relativePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

/** 为已经过安全校验的工作区相对路径创建父目录。 */
/**
 * 功能：确保`safe` `parent` 目录。
 * 输入：`workspaceRoot`（string）提供工作区 根目录。 `relativePath`（string）提供relative 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:createWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:uploadWorkspaceFile()`、`apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:writeFile()`、`apps/server/src/modules/workspaces/patch-apply.service.ts:preparePatchTargets()`、`apps/server/src/modules/workspaces/scaffold.service.ts:applyCurrentMarkdownSavePlan()` 调用；内部调用 `safePathResolve()`、`assertNoSymlinkPath()`、`dirname()`、`mkdir()`。
 */
export async function ensureSafeParentDirectory(workspaceRoot: string, relativePath: string) {
  const resolved = safePathResolve(workspaceRoot, relativePath);
  await assertNoSymlinkPath(workspaceRoot, path.dirname(relativePath));
  await fs.mkdir(path.dirname(resolved), { recursive: true });
}
