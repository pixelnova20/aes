/**
 * 文件作用：实现后端“学生工作区”业务模块中的 `normalizePatchPath`、`extractPatchPaths`、`validatePatchFormat` 等能力。
 * 模块位置：`apps/server/src/modules/workspaces/patch-safety.ts`，属于后端“学生工作区”业务模块。
 * 重要函数：`normalizePatchPath()` 负责规范化补丁 路径；`extractPatchPaths()` 负责提取补丁 `paths`；`validatePatchFormat()` 负责校验补丁 `format`；`fixHunkLineCounts()` 负责处理`fix` `hunk` `line` `counts`；`validatePatchPaths()` 负责校验补丁 `paths`；`validatePatch()` 负责校验补丁。
 */
const BLOCKED_SEGMENTS = new Set([".git", ".env", ".checkpoints", "node_modules"]);
const UNSUPPORTED_PATCH_MARKERS = ["GIT binary patch", "rename from ", "rename to "];

/**
 * 功能：规范化补丁 路径。
 * 输入：`rawPath`（string）提供raw 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/patch-safety.ts:extractPatchPaths()`、`apps/server/src/modules/workspaces/patch-safety.ts:validatePatchFormat()` 调用；内部调用 `replace()`。
 */
function normalizePatchPath(rawPath: string) {
  return rawPath.replace(/^a\//, "").replace(/^b\//, "").replace(/\\/g, "/");
}

/**
 * 功能：提取补丁 `paths`。
 * 输入：`patch`（string）提供补丁。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/patch-apply.service.ts:preparePatchTargets()`、`apps/server/src/modules/workspaces/patch-safety.ts:validatePatchPaths()` 调用；内部调用 `split()`、`startsWith()`、`add()`、`normalizePatchPath()`。
 */
export function extractPatchPaths(patch: string) {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) continue;
    const raw = line.slice(4).trim().split(/\s+/)[0];
    if (raw === "/dev/null") continue;
    paths.add(normalizePatchPath(raw));
  }
  return [...paths];
}

/** 检查 unified diff 的基本结构，防止路径安全通过但 git apply 仍然解析失败。 */
/**
 * 功能：校验补丁 `format`。
 * 输入：`patch`（string）提供补丁。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/workspaces/patch-safety.ts:validatePatch()` 调用；内部调用 `split()`、`startsWith()`、`normalizePatchPath()`。
 */
export function validatePatchFormat(patch: string) {
  const errors: string[] = [];
  const lines = patch.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!line.startsWith("+++ ")) continue;
    const rawTarget = line.slice(4).trim().split(/\s+/)[0] ?? "";
    if (rawTarget === "/dev/null") continue;
    const target = normalizePatchPath(rawTarget);
    let hasHunk = false;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor] ?? "";
      if (next.startsWith("diff --git ") || next.startsWith("--- ")) break;
      if (next.startsWith("@@ ")) {
        hasHunk = true;
        break;
      }
    }
    const previous = lines[index - 1] ?? "";
    if (previous.startsWith("--- /dev/null") && !hasHunk) {
      errors.push(`New file diff has no @@ hunk and cannot be applied reliably: ${target}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** 自动修正 @@ hunk 头中 AI 计数错误的行数，避免 "corrupt patch at line N" 错误。 */
/**
 * 功能：处理`fix` `hunk` `line` `counts`。
 * 输入：`patch`（string）提供补丁。
 * 输出：返回 { patch: string; fixed: boolean }，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/workspaces/patch-apply.service.ts:applyWorkspacePatch()` 调用；内部调用 `split()`、`match()`、`parseInt()`、`startsWith()`。
 */
export function fixHunkLineCounts(patch: string): { patch: string; fixed: boolean } {
  const lines = patch.split(/\r?\n/);
  let fixed = false;
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);

    if (!hunkMatch) {
      result.push(line);
      continue;
    }

    const oldStart = hunkMatch[1] ?? "0";
    const claimedOld = parseInt(hunkMatch[2] || "1", 10);
    const newStart = hunkMatch[3] ?? "0";
    const claimedNew = parseInt(hunkMatch[4] || "1", 10);

    // 统计实际内容行数
    let actualOld = 0;
    let actualNew = 0;
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j] ?? "";
      if (next.startsWith("@@ ") || next.startsWith("diff --git ") || next.startsWith("--- ")) break;
      if (next.startsWith(" ")) { actualOld++; actualNew++; }
      else if (next.startsWith("+")) actualNew++;
      else if (next.startsWith("-")) actualOld++;
      j++;
    }

    if ((actualNew > 0 && actualNew !== claimedNew) || (actualOld > 0 && actualOld !== claimedOld)) {
      result.push(`@@ -${oldStart},${actualOld || claimedOld} +${newStart},${actualNew || claimedNew} @@`);
      fixed = true;
    } else {
      result.push(line);
    }
  }

  return { patch: result.join("\n"), fixed };
}

/** 后端在工作区应用补丁前，先校验 unified diff 中的路径。 */
/**
 * 功能：校验补丁 `paths`。
 * 输入：`patch`（string）提供补丁。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/workspaces/patch-safety.ts:validatePatch()` 调用；内部调用 `extractPatchPaths()`、`includes()`、`some()`、`split()`、`startsWith()`、`has()`。
 */
export function validatePatchPaths(patch: string) {
  const errors: string[] = [];
  const paths = extractPatchPaths(patch);
  if (!patch.includes("--- ") || !patch.includes("+++ ")) errors.push("Patch is not a unified diff.");
  if (UNSUPPORTED_PATCH_MARKERS.some((marker) => patch.includes(marker))) errors.push("Patch uses unsupported binary or rename operations.");
  for (const filePath of paths) {
    const segments = filePath.split("/").filter(Boolean);
    if (!filePath || filePath.startsWith("/") || filePath.includes("..")) errors.push(`Unsafe path: ${filePath}`);
    if (segments.some((segment) => BLOCKED_SEGMENTS.has(segment))) errors.push(`Blocked path segment in: ${filePath}`);
  }
  return { ok: errors.length === 0, paths, errors };
}

export type PatchValidationResult = {
  ok: boolean;
  validationMarkdown: string;
  errors: string[];
};

/**
 * 功能：校验补丁。
 * 输入：`patch`（string）提供补丁。
 * 输出：返回 PatchValidationResult，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/workspaces/patch-apply.service.ts:applyWorkspacePatch()` 调用；内部调用 `validatePatchPaths()`、`validatePatchFormat()`。
 */
export function validatePatch(patch: string): PatchValidationResult {
  const pathResult = validatePatchPaths(patch);
  const formatResult = validatePatchFormat(patch);
  const errors = [...pathResult.errors, ...formatResult.errors];
  const ok = errors.length === 0;
  return {
    ok,
    errors,
    validationMarkdown: ok
      ? `## Patch Validation\n\nPatch paths and basic diff format are safe.\n\n${pathResult.paths.map((file) => `- \`${file}\``).join("\n")}`
      : `## Patch Validation Failed\n\n${errors.map((error) => `- ${error}`).join("\n")}`,
  };
}
