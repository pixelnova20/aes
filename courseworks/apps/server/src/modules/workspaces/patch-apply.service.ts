/**
 * 文件作用：实现后端“学生工作区”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/workspaces/patch-apply.service.ts`，属于后端“学生工作区”业务模块。
 * 重要函数：`runGitApply()` 负责执行`git` `apply`；`preparePatchTargets()` 负责准备补丁 `targets`；`applyWorkspacePatch()` 负责应用工作区 补丁。
 */
import { spawn } from "node:child_process";
import path from "node:path";

import { extractPatchPaths, fixHunkLineCounts, validatePatch } from "./patch-safety.js";
import { assertNoSymlinkPath, assertWorkspaceRoot, ensureSafeParentDirectory } from "./safe-path.service.js";

const PATCH_TIMEOUT_MS = 15000;
const MAX_PATCH_OUTPUT = 256 * 1024;

/**
 * 功能：执行`git` `apply`。
 * 输入：`workspacePath`（string）提供工作区 路径。 `patch`（string）提供补丁。 `checkOnly`（boolean）提供check only。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/patch-apply.service.ts:applyWorkspacePatch()` 调用；内部调用 `spawn()`、`dirname()`、`toString()`、`setTimeout()`、`kill()`、`on()`。
 */
function runGitApply(workspacePath: string, patch: string, checkOnly: boolean) {
  return new Promise<{ exitCode: number; output: string; timedOut: boolean }>((resolve) => {
    const args = checkOnly ? ["apply", "--no-index", "--check", "--whitespace=nowarn", "-"] : ["apply", "--no-index", "--whitespace=nowarn", "-"];
    const child = spawn("git", args, {
      cwd: workspacePath,
      shell: false,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(workspacePath) }
    });
    let output = "";
    let timedOut = false;
    /**
     * 功能：追加`append` 对应的数据。
     * 输入：`chunk`（Buffer）提供chunk。
     * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
     * 调用关系：由 `apps/web/src/features/lab/LabPage.tsx:copyTerminalSelection()`、`apps/web/src/features/workspace/workspace-utils.ts:textareaCaretTop()` 调用；内部调用 `toString()`。
     */
    const append = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-MAX_PATCH_OUTPUT);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PATCH_TIMEOUT_MS);
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, output: error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output, timedOut });
    });
    child.stdin.end(patch);
  });
}

/**
 * 功能：准备补丁 `targets`。
 * 输入：`workspacePath`（string）提供工作区 路径。 `patch`（string）提供补丁。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/patch-apply.service.ts:applyWorkspacePatch()` 调用；内部调用 `assertWorkspaceRoot()`、`extractPatchPaths()`、`assertNoSymlinkPath()`、`ensureSafeParentDirectory()`。
 */
async function preparePatchTargets(workspacePath: string, patch: string) {
  assertWorkspaceRoot(workspacePath);
  const paths = extractPatchPaths(patch);
  for (const filePath of paths) {
    await assertNoSymlinkPath(workspacePath, filePath);
    await ensureSafeParentDirectory(workspacePath, filePath);
  }
}

/** 使用不经过 shell 的 git apply 在工作区内应用已校验的 unified diff，支持创建、修改和删除。 */
/**
 * 功能：应用工作区 补丁。
 * 输入：`workspacePath`（string）提供工作区 路径。 `patch`（string）提供补丁。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:applyAgentPatchPlan()` 调用；内部调用 `validatePatch()`、`preparePatchTargets()`、`fixHunkLineCounts()`、`runGitApply()`。
 */
export async function applyWorkspacePatch(workspacePath: string, patch: string) {
  const validation = validatePatch(patch);
  if (!validation.ok) throw new Error(validation.errors.join("; "));

  await preparePatchTargets(workspacePath, patch);

  const fixed = fixHunkLineCounts(patch);
  const appliedPatch = fixed.fixed ? fixed.patch : patch;

  const check = await runGitApply(workspacePath, appliedPatch, true);
  if (check.timedOut) throw new Error("Patch validation timed out.");
  if (check.exitCode !== 0) throw new Error(check.output || "Patch check failed.");

  const result = await runGitApply(workspacePath, appliedPatch, false);
  if (result.timedOut) throw new Error("Patch apply timed out.");
  if (result.exitCode !== 0) throw new Error(result.output || "Patch apply failed.");
  return result;
}
