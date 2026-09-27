/**
 * 文件作用：实现后端“学生工作区”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/workspaces/scaffold.service.ts`，属于后端“学生工作区”业务模块。
 * 重要函数：`hasSemanticFileContentRequest()` 负责判断是否包含`semantic` 文件 `content` 请求；`shouldUseDeterministicWorkspaceScaffold()` 负责判断是否应当`use` `deterministic` 工作区 `scaffold`；`normalizeRelativePath()` 负责规范化`relative` 路径；`unique()` 负责处理`unique`；`stripPathQuotes()` 负责处理`strip` 路径 `quotes`；`isSafeStructureToken()` 负责判断是否为`safe` `structure` Token；`normalizeStructureToken()` 负责规范化`structure` Token；`containsAsciiPathSignal()` 负责处理`contains` `ascii` 路径 `signal`。
 */
import fs from "node:fs/promises";

import { assertNoSymlinkPath, ensureSafeParentDirectory, safePathResolve } from "./safe-path.service.js";

export type WorkspaceStructurePlan = {
  directories: string[];
  files: Array<{ path: string; content: string }>;
};

export type WorkspaceStructureResult = {
  createdDirectories: string[];
  existingDirectories: string[];
  createdFiles: string[];
  existingFiles: string[];
};

export type WorkspaceDeletePlan = {
  directories: string[];
};

export type WorkspaceDeleteResult = {
  deletedDirectories: string[];
  missingDirectories: string[];
};

export type WorkspaceClearResult = {
  deletedEntries: string[];
};

export type WorkspaceAttachmentSavePlan = {
  directory: string;
};

export type WorkspaceFileExportPlan = {
  filePath: string;
};

export type WorkspaceCurrentMarkdownSavePlan = {
  filePath: string;
  content: string;
};

export type WorkspaceCurrentMarkdownSaveResult = {
  filePath: string;
  action: "created" | "replaced";
};

const IGNORED_TOKENS = new Set([
  "run",
  "clean",
  "cscope",
  "make",
  "make run",
  "make clean",
  "make cscope",
  "QEMU",
  "OpenSBI",
  "S-mode kernel",
  "qemu-system-riscv64",
  "riscv64 virt"
]);

const IGNORED_STRUCTURE_NAME_TOKENS = new Set([
  "一个",
  "1个",
  "新的",
  "目录",
  "文件夹",
  "directory",
  "folder"
]);

const PURE_STRUCTURE_PATTERNS = [
  /工程目录约束/,
  /根目录应包含/,
  /下至少应包含/,
  /根目录必须包含/,
  /将内容存成/,
  /放置在工程的根目录/,
  /(?:最小|基础|项目|工程).*(?:骨架|结构|scaffold)/i,
  /(?:创建|新建|建立|生成|添加).*(?:Makefile|README|src\/?|目录|文件|target)/i,
  /(?:create|make|add).*(?:Makefile|README|src\/?|directory|folder|file|target)/i,
  /(?:创建|新建|建立|生成).*(?:目录|文件夹)/,
  /(?:create|make|add).*(?:directory|folder)/i
];

const IMPLEMENTATION_PATTERNS = [
  /设计目标/,
  /验证要求/,
  /实现/,
  /完成第.*阶段/,
  /启动链/,
  /kernel shell/i,
  /kernel_main/i,
  /boot 入口/,
  /linker\.ld/i,
  /hartid/i,
  /\.bss/,
  /OpenSBI 控制台/,
  /工具检查/,
  /启动后必须/,
  /命令执行后必须/
];

/**
 * 功能：判断是否包含`semantic` 文件 `content` 请求。
 * 输入：`prompt`（string）提供提示词。 `plan`（WorkspaceStructurePlan）提供计划。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.ts:shouldUseDeterministicWorkspaceScaffold()` 调用；内部调用 `test()`、`some()`。
 */
function hasSemanticFileContentRequest(prompt: string, plan: WorkspaceStructurePlan) {
  // scaffold 只能创建"纯结构"。如果用户已经描述了文件内容、代码语义或构建 target，
  // 继续创建占位文件会让一次真实实现请求被误判为成功，因此必须交给 LLM patch 流程。
  if (plan.files.length === 0) return false;
  const explicitlyScaffoldOnly = /(?:最小|基础|项目|工程).*(?:骨架|结构|scaffold)/i.test(prompt) &&
    /(不要|无需|不需要|暂时不要|禁止).*(?:代码|实现|kernel_main|main\s*\()/i.test(prompt);
  if (explicitlyScaffoldOnly) return false;
  const mentionsMakefile = plan.files.some((file) => /^Makefile$/i.test(file.path));
  const mentionsCodeFile = plan.files.some((file) => /\.(?:c|h|S|ld)$/i.test(file.path));
  return [
    /(内容为|内容是|写一句|写入.*内容|包含.*target|target|构建规则|编译规则)/i.test(prompt),
    /(打印|printf|#include|main\s*\(|函数|代码|实现|链接脚本|入口)/i.test(prompt),
    mentionsMakefile && /(run|clean|target|make\s+)/i.test(prompt),
    mentionsCodeFile && /(内容|打印|printf|#include|函数|代码|实现|入口)/i.test(prompt)
  ].some(Boolean);
}

/**
 * 功能：判断是否应当`use` `deterministic` 工作区 `scaffold`。
 * 输入：`prompt`（string）提供提示词。 `plan`（WorkspaceStructurePlan | null）提供计划。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.test.ts 顶层流程` 调用；内部调用 `hasSemanticFileContentRequest()`、`some()`、`test()`、`split()`。
 */
export function shouldUseDeterministicWorkspaceScaffold(prompt: string, plan: WorkspaceStructurePlan | null) {
  if (!plan) return false;
  const totalItems = plan.directories.length + plan.files.length;
  if (totalItems === 0) return false;
  if (hasSemanticFileContentRequest(prompt, plan)) return false;
  const hasStructureSignals = PURE_STRUCTURE_PATTERNS.some((pattern) => pattern.test(prompt));
  // "不要创建 kernel_main"这类否定约束不表示用户要进入内核实现阶段。
  const promptWithoutNegativeConstraints = prompt.split(/\r?\n/).filter((line) => !/(不要|无需|不需要|禁止|do not|don't)/i.test(line)).join("\n");
  const hasImplementationSignals = IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(promptWithoutNegativeConstraints));
  return hasStructureSignals && !hasImplementationSignals;
}

const ROOT_FILE_PATTERN = /^(?:Makefile|README\.txt|readme\.txt|[\w\u4e00-\u9fa5.-]+\.(?:txt|md|c|h|S|ld|json|mk))$/i;

/**
 * 功能：规范化`relative` 路径。
 * 输入：`value`（string）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/workspace/workspace-application.service.ts:assertNotWorkspaceRoot()`、`apps/server/src/application/workspace/workspace-application.service.ts:readWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:createWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:saveWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:uploadWorkspaceFile()` 调用；内部调用 `replace()`。
 */
function normalizeRelativePath(value: string) {
  return value.replace(/\\/g, "/").trim();
}

/**
 * 功能：处理`unique`。
 * 输入：`items`（T[]）提供items。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.ts:extractWorkspaceStructurePlan()`、`apps/server/src/modules/workspaces/scaffold.service.ts:extractWorkspaceDeletePlan()`、`apps/server/src/modules/workspaces/scaffold.service.ts:applyWorkspaceStructurePlan()`、`apps/server/src/modules/workspaces/scaffold.service.ts:applyWorkspaceDeletePlan()` 调用。
 */
function unique<T>(items: T[]) {
  return [...new Set(items)];
}

/**
 * 功能：处理`strip` 路径 `quotes`。
 * 输入：`value`（string）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.ts:normalizeStructureToken()` 调用；内部调用 `replace()`。
 */
function stripPathQuotes(value: string) {
  return value.replace(/^[`"'""‘’]+|[`"'""‘’]+$/g, "").trim();
}

/**
 * 功能：判断是否为`safe` `structure` Token。
 * 输入：`value`（string）提供value。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.ts:isSafeWorkspaceFilePath()`、`apps/server/src/modules/workspaces/scaffold.service.ts:extractDirectFileTokens()` 调用；内部调用 `has()`、`startsWith()`、`test()`、`some()`、`split()`。
 */
function isSafeStructureToken(value: string) {
  if (!value || value === "." || value === "..") return false;
  if (IGNORED_STRUCTURE_NAME_TOKENS.has(value)) return false;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value.split("/").some((part) => !part || part === "." || part === "..");
}

/**
 * 功能：规范化`structure` Token。
 * 输入：`value`（string）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.ts:extractDirectDirectoryTokens()`、`apps/server/src/modules/workspaces/scaffold.service.ts:extractInlineDirectoryPathTokens()`、`apps/server/src/modules/workspaces/scaffold.service.ts:extractInlineRootFileTokens()`、`apps/server/src/modules/workspaces/scaffold.service.ts:extractDirectFileTokens()`、`apps/server/src/modules/workspaces/scaffold.service.ts:extractWorkspaceStructurePlan()` 调用；内部调用 `replace()`、`normalizeRelativePath()`、`stripPathQuotes()`。
 */
function normalizeStructureToken(value: string) {
  return normalizeRelativePath(stripPathQuotes(value)).replace(/\/+$/, "");
}

/**
 * 功能：处理`contains` `ascii` 路径 `signal`。
 * 输入：`value`（string）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.ts:shouldAcceptBareDirectoryName()`、`apps/server/src/modules/workspaces/scaffold.service.ts:extractDirectDirectoryTokens()` 调用；内部调用 `test()`。
 */
function containsAsciiPathSignal(value: string) {
  return /[A-Za-z0-9_.\-/]/.test(value);
}

/**
 * 功能：判断是否应当`accept` `bare` 目录 `name`。
 * 输入：`value`（string）提供value。 `explicitNameMarker`（boolean）提供explicit name marker。 `wasQuoted`（boolean）提供was quoted。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.ts:extractDirectDirectoryTokens()` 调用；内部调用 `includes()`、`containsAsciiPathSignal()`。
 */
function shouldAcceptBareDirectoryName(value: string, explicitNameMarker: boolean, wasQuoted: boolean) {
  // 未加引号、没有"名字叫/称为"等标记的中文短语常常只是修饰"目录"的描述，
  // 例如"所有工作目录"。这类表达应交给 planner/LLM 结合上下文处理，不能直接当路径创建。
  if (explicitNameMarker || wasQuoted) return true;
  if (value.includes("/")) return true;
  return containsAsciiPathSignal(value);
}

/**
 * 功能：判断是否为`safe` 工作区 文件 路径。
 * 输入：`value`（string）提供value。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `isSafeStructureToken()`、`pop()`、`split()`、`test()`。
 */
function isSafeWorkspaceFilePath(value: string) {
  if (!isSafeStructureToken(value)) return false;
  const fileName = value.split("/").pop() ?? "";
  return /\.[A-Za-z0-9]+$/.test(fileName);
}

/**
 * 功能：提取`direct` 目录 Token 数量。
 * 输入：`prompt`（string）提供提示词。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.ts:extractWorkspaceStructurePlan()` 调用；内部调用 `matchAll()`、`split()`、`replace()`、`includes()`、`containsAsciiPathSignal()`、`endsWith()`。
 */
function extractDirectDirectoryTokens(prompt: string) {
  // 处理"创建一个目录，名字叫 prompts"这类自然语言请求；
  // 这里只抽取紧邻"目录/文件夹/directory/folder"语义的路径，不扫描整句中的任意单词。
  const candidates: Array<{ value: string; explicitNameMarker: boolean; wasQuoted: boolean }> = [];
  for (const match of prompt.matchAll(/(?:创建|新建|建立|生成|添加)\s*(?:一个|1个|新的)?\s*((?:名(?:字|称)?(?:叫|为|是)|叫做|为)\s*)?([`"'""‘’]?)([A-Za-z0-9_\-./\u4e00-\u9fa5]+)\3\s*(?:这个)?(?:目录|文件夹)/gi)) {
    candidates.push({
      value: match[4] ?? "",
      explicitNameMarker: Boolean(match[1]),
      wasQuoted: Boolean(match[3])
    });
  }
  for (const match of prompt.matchAll(/(?:创建|新建|建立|生成|添加)\s*(?:一个|1个|新的)?\s*(?:目录|文件夹)\s*[，,、]?\s*(名(?:字|称)?(?:叫|为|是)|叫做|为)\s*([`"'""‘’]?)([A-Za-z0-9_\-./\u4e00-\u9fa5]+)\2/gi)) {
    candidates.push({
      value: match[3] ?? "",
      explicitNameMarker: true,
      wasQuoted: Boolean(match[2])
    });
  }
  for (const match of prompt.matchAll(/(?:创建|新建|建立|生成|添加)\s*(?:一个|1个|新的)?\s*(?:目录|文件夹)\s*(?:(名(?:字|称)?(?:叫|为|是)|叫做|为|named|called)\s*)?([`"'""‘’]?)([A-Za-z0-9_\-./\u4e00-\u9fa5]+)\2/gi)) {
    candidates.push({
      value: match[3] ?? "",
      explicitNameMarker: Boolean(match[1]),
      wasQuoted: Boolean(match[2])
    });
  }
  for (const match of prompt.matchAll(/(?:create|make|add)\s+(?:a\s+|an\s+|new\s+)?(?:directory|folder)\s+(?:(named|called)\s+)?([`"’""’’]?)([A-Za-z0-9_\-./]+)\2/gi)) {
    candidates.push({
      value: match[3] ?? "",
      explicitNameMarker: Boolean(match[1]),
      wasQuoted: Boolean(match[2])
    });
  }
  // 匹配 "创建三个目录：src/、include/、docs/" 或 "create directories: a/, b/" 这类列表格式
  for (const match of prompt.matchAll(/(?:创建|新建|建立|生成|添加)\s*(?:[0-9一二三四五六七八九十]+个|几个|以下|下列|这些|新的|一些)?\s*(?:目录|文件夹)\s*[：:]\s*([^。.!!?\n]{3,})/gi)) {
    const list = match[1] ?? "";
    const tokens = list.split(/[、,，\s]+/).filter(Boolean);
    for (const token of tokens) {
      const cleaned = token.replace(/[；;].*$/, "").trim();
      if (cleaned && (cleaned.includes("/") || containsAsciiPathSignal(cleaned))) {
        candidates.push({
          value: cleaned.endsWith("/") ? cleaned : `${cleaned}/`,
          explicitNameMarker: false,
          wasQuoted: false
        });
      }
    }
  }
  return candidates
    .map((candidate) => ({
      ...candidate,
      value: normalizeStructureToken(candidate.value)
    }))
    .filter((candidate) => shouldAcceptBareDirectoryName(candidate.value, candidate.explicitNameMarker, candidate.wasQuoted))
    .map((candidate) => candidate.value)
    .filter(isSafeStructureToken);
}

/**
 * 功能：提取`inline` 目录 路径 Token 数量。
 * 输入：`prompt`（string）提供提示词。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.ts:extractWorkspaceStructurePlan()` 调用；内部调用 `matchAll()`、`normalizeStructureToken()`。
 */
function extractInlineDirectoryPathTokens(prompt: string) {
  // 处理"创建 src/ 目录"这类短 prompt；只接受显式带斜杠的相对路径，避免普通中文短语被当成目录名。
  const matches = [
    ...prompt.matchAll(/(?:创建|新建|建立|生成|添加)\s+([A-Za-z0-9_\-./]+\/?)\s*(?:目录|文件夹)/gi),
    ...prompt.matchAll(/(?:create|make|add)\s+(?:directory|folder)\s+([A-Za-z0-9_\-./]+\/?)/gi),
    ...prompt.matchAll(/(?:create|make|add)\s+([A-Za-z0-9_\-./]+\/)\s*(?:directory|folder)?/gi)
  ];
  return matches
    .map((match) => normalizeStructureToken(match[1] ?? ""))
    .filter(isSafeStructureToken);
}

/**
 * 功能：提取`inline` 根目录 文件 Token 数量。
 * 输入：`prompt`（string）提供提示词。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.ts:extractWorkspaceStructurePlan()` 调用；内部调用 `matchAll()`、`normalizeStructureToken()`、`test()`。
 */
function extractInlineRootFileTokens(prompt: string) {
  // 处理"创建 Makefile / README.md"这类短 prompt，只接受常见根文件名和带扩展名文件。
  const matches = [
    ...prompt.matchAll(/(?:创建|新建|建立|生成|添加)\s+([A-Za-z0-9_.-]+(?:\.[A-Za-z0-9]+)?)/gi),
    ...prompt.matchAll(/(?:create|make|add)\s+([A-Za-z0-9_.-]+(?:\.[A-Za-z0-9]+)?)/gi)
  ];
  return matches
    .map((match) => normalizeStructureToken(match[1] ?? ""))
    .filter((token) => ROOT_FILE_PATTERN.test(token));
}

/**
 * 功能：提取`direct` 文件 Token 数量。
 * 输入：`prompt`（string）提供提示词。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.ts:extractWorkspaceStructurePlan()` 调用；内部调用 `test()`、`matchAll()`、`normalizeStructureToken()`、`isSafeStructureToken()`。
 */
function extractDirectFileTokens(prompt: string) {
  // 处理"创建一个 README.md 文件""创建一个名为 notes.txt 的文件"
  // 以及 "create file README.md" 这类明确文件创建请求；这里只抽取文件路径，不推断文件内容。
  const hasCreateIntent = /(?:创建|新建|建立|生成|添加|create|make|add)/i.test(prompt);
  const matches = [
    ...prompt.matchAll(/(?:创建|新建|建立|生成|添加)\s*(?:一个|1个|新的)?\s*(?:(?:名(?:字|称)?(?:叫|为|是)|叫做|为)\s*)?([`"'""‘’]?)([A-Za-z0-9_\-./\u4e00-\u9fa5]+\.[A-Za-z0-9]+|Makefile|README\.md|README\.txt)\1\s*的\s*(?:文件|file)/gi),
    ...prompt.matchAll(/(?:创建|新建|建立|生成|添加)\s*(?:一个|1个|新的)?\s*(?:(?:名(?:字|称)?(?:叫|为|是)|叫做|为)\s*)?([`"'""‘’]?)([A-Za-z0-9_\-./\u4e00-\u9fa5]+\.[A-Za-z0-9]+|Makefile|README\.md|README\.txt)\1\s*(?:的\s*[A-Za-z0-9_\-\u4e00-\u9fa5]+\s*)?(?:文件|file)/gi),
    ...prompt.matchAll(/(?:创建|新建|建立|生成|添加)\s*(?:一个|1个|新的)?\s*(?:文件|file)\s*[，,、]?\s*(?:(?:名(?:字|称)?(?:叫|为|是)|叫做|为)\s*)?([`"'""‘’]?)([A-Za-z0-9_\-./\u4e00-\u9fa5]+\.[A-Za-z0-9]+|Makefile|README\.md|README\.txt)\1/gi),
    ...prompt.matchAll(/(?:create|make|add)\s+(?:a\s+|an\s+|new\s+)?(?:file)\s+(?:(?:named|called)\s+)?([`"'""‘’]?)([A-Za-z0-9_\-./]+\.[A-Za-z0-9]+|Makefile|README\.md|README\.txt)\1/gi),
    ...prompt.matchAll(/(?:create|make|add)\s+(?:a\s+|an\s+|new\s+)?([`"'""‘’]?)([A-Za-z0-9_\-./]+\.[A-Za-z0-9]+|Makefile|README\.md|README\.txt)\1\s+(?:file)/gi),
    ...(hasCreateIntent ? [
      ...prompt.matchAll(/(?:文件|file)\s*[，,、]?\s*(?:(?:名(?:字|称)?(?:叫|为|是)|叫做|为|named|called)\s*)?([`"'""‘’]?)([A-Za-z0-9_\-./\u4e00-\u9fa5]+\.[A-Za-z0-9]+|Makefile|README\.md|README\.txt)\1/gi)
    ] : [])
  ];
  return matches
    .map((match) => normalizeStructureToken(match[2] ?? ""))
    .filter((token) => isSafeStructureToken(token) && ROOT_FILE_PATTERN.test(token));
}

/**
 * 功能：构建文件 `placeholder`。
 * 输入：`filePath`（string）提供文件 路径。 `prompt`（string）提供提示词。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.ts:extractWorkspaceStructurePlan()` 调用；内部调用 `pop()`、`split()`、`test()`、`match()`。
 */
function buildFilePlaceholder(filePath: string, prompt: string) {
  const baseName = filePath.split("/").pop() ?? filePath;
  // 占位内容只根据用户明确写出的文件名和少量通用意图生成，避免把某门课程的模板偷偷写进通用工作区。
  if (/^readme\.md$/i.test(baseName)) {
    const projectName = prompt.match(/(?:为|项目名|项目名称)\s*([A-Za-z0-9_-]+)/)?.[1] ?? "Project";
    return [
      `# ${projectName}`,
      "",
      `${projectName} is a minimal project scaffold prepared for iterative development. Replace this note with the course-specific goal when the project requirements are clear.`,
      ""
    ].join("\n");
  }
  if (/^readme\.txt$/i.test(baseName)) {
    const projectName = prompt.match(/项目名称[^`]*`([^`]+)`/)?.[1] ?? prompt.match(/(?:为|项目名|项目名称)\s*([A-Za-z0-9_-]+)/)?.[1] ?? "Project";
    return [
      `Project: ${projectName}`,
      "Design goal: describe the course-specific objective here.",
      "Notes: keep this file aligned with the current assignment and workspace state.",
      ""
    ].join("\n");
  }
  if (/^Makefile$/i.test(baseName)) {
    const wantsCscope = /\bcscope\b/i.test(prompt);
    const phonyTargets = wantsCscope ? "run clean cscope" : "run clean";
    const baseTargets = [
      `.PHONY: ${phonyTargets}`,
      "",
      "run:",
      "\t@echo \"run target is not implemented yet\"",
      "",
      "clean:",
      "\trm -rf build cscope.files cscope.out cscope.in.out cscope.po.out tags",
      "",
    ];
    const cscopeTarget = wantsCscope ? [
      "cscope:",
      "\t@find . -type f \\( -name '*.c' -o -name '*.h' -o -name '*.S' \\) > cscope.files",
      ""
    ] : [];
    return [...baseTargets, ...cscopeTarget].join("\n");
  }
  if (/前置约束\.md$/i.test(baseName)) {
    return `${prompt.trim()}\n`;
  }
  return "";
}

/**
 * 功能：提取工作区 `structure` 计划。
 * 输入：`prompt`（string）提供提示词。
 * 输出：返回 WorkspaceStructurePlan | null，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.test.ts 顶层流程` 调用；内部调用 `matchAll()`、`normalizeRelativePath()`、`has()`、`endsWith()`、`extractDirectDirectoryTokens()`、`extractInlineDirectoryPathTokens()`。
 */
export function extractWorkspaceStructurePlan(prompt: string): WorkspaceStructurePlan | null {
  const tokens = [...prompt.matchAll(/`([^`]+)`/g)]
    .map((match) => normalizeRelativePath(match[1] ?? ""))
    .filter(Boolean);

  const filtered = tokens.filter((token) => !IGNORED_TOKENS.has(token));
  const directoryTokens = filtered.filter((token) => token.endsWith("/"));
  const directDirectoryTokens = extractDirectDirectoryTokens(prompt);
  const inlineDirectoryTokens = extractInlineDirectoryPathTokens(prompt);
  const inlineFileTokens = extractInlineRootFileTokens(prompt);
  const directFileTokens = extractDirectFileTokens(prompt);
  const fileTokens = filtered.filter((token) => {
    if (token.endsWith("/")) return false;
    if (token.includes("/")) return true;
    return ROOT_FILE_PATTERN.test(token);
  });

  if (directoryTokens.length === 0 && directDirectoryTokens.length === 0 && inlineDirectoryTokens.length === 0 && fileTokens.length === 0 && inlineFileTokens.length === 0 && directFileTokens.length === 0) return null;

  return {
    directories: unique([
      ...directoryTokens.map((token) => normalizeStructureToken(token)),
      ...directDirectoryTokens,
      ...inlineDirectoryTokens
    ]).filter(Boolean),
    files: unique([...fileTokens, ...inlineFileTokens, ...directFileTokens]).map((filePath) => ({
      path: filePath,
      content: buildFilePlaceholder(filePath, prompt)
    }))
  };
}

/**
 * 功能：提取工作区 `delete` 计划。
 * 输入：`prompt`（string）提供提示词。
 * 输出：返回 WorkspaceDeletePlan | null，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.test.ts 顶层流程` 调用；内部调用 `split()`、`test()`、`matchAll()`、`normalizeRelativePath()`、`unique()`。
 */
export function extractWorkspaceDeletePlan(prompt: string): WorkspaceDeletePlan | null {
  const candidates: string[] = [];
  let insideFence = false;
  for (const rawLine of prompt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^```/.test(line)) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;
    // 文档条款、列表项和标题中的"删除"通常是在描述规则，不是当前用户的直接删除命令。
    if (!line || /^[-*+>]/.test(line) || /^#{1,6}\s/.test(line)) continue;
    const matches = [
      ...line.matchAll(/^(?:请|帮我|麻烦)?\s*(?:删除|删掉|移除|去掉)\s*(?:["`""']?)([A-Za-z0-9_\-./\u4e00-\u9fa5]+)(?:["`""']?)\s*(?:目录|文件夹|folder|directory)\s*[。！!,.，\s]*$/gi),
      ...line.matchAll(/^(?:please\s+)?(?:delete|remove)\s+(?:the\s+)?(?:directory|folder)\s+[`"'""‘’]?([A-Za-z0-9_\-./]+)[`"'""‘’]?\s*$/gi)
    ];
    candidates.push(...matches.map((match) => normalizeRelativePath(match[1] ?? "")));
  }
  const directories = unique(candidates.filter(isSafeStructureToken));
  if (directories.length === 0) return null;
  return { directories };
}

/**
 * 功能：提取工作区 `attachment` `save` 计划。
 * 输入：`prompt`（string）提供提示词。
 * 输出：返回 WorkspaceAttachmentSavePlan | null，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.test.ts 顶层流程` 调用；内部调用 `test()`、`matchAll()`、`normalizeStructureToken()`。
 */
export function extractWorkspaceAttachmentSavePlan(prompt: string): WorkspaceAttachmentSavePlan | null {
  if (!/(附件|上传|attachment|upload)/i.test(prompt)) return null;
  if (!/(保存|存放|放到|放入|复制|拷贝|写入|save|copy|put|place)/i.test(prompt)) return null;
  const matches = [
    ...prompt.matchAll(/(?:到|至|进|在|into|to)\s*(?:工作区|workspace|项目|工程)?(?:的|\/)?\s*[`"'""‘’]?([A-Za-z0-9_\-./\u4e00-\u9fa5]+)[`"'""‘’]?\s*(?:目录|文件夹|folder|directory)/gi),
    ...prompt.matchAll(/(?:工作区|workspace|项目|工程)(?:的|\/)\s*[`"'""‘’]?([A-Za-z0-9_\-./\u4e00-\u9fa5]+)[`"'""‘’]?\s*(?:目录|文件夹|folder|directory)/gi)
  ];
  const directories = matches
    .map((match) => normalizeStructureToken(match[1] ?? ""))
    .filter(isSafeStructureToken)
    .filter((directory) => !/^(工作区|workspace|项目|工程)$/i.test(directory));
  const directory = directories[0];
  return directory ? { directory } : null;
}

/**
 * 功能：提取工作区 文件 `export` 计划。
 * 输入：`prompt`（string）提供提示词。
 * 输出：返回 WorkspaceFileExportPlan | null，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.test.ts 顶层流程` 调用；内部调用 `test()`、`matchAll()`、`flatMap()`、`normalizeStructureToken()`、`find()`。
 */
export function extractWorkspaceFileExportPlan(prompt: string): WorkspaceFileExportPlan | null {
  // 处理"把 workspace 里的某个文件放到聊天窗口/供下载"这类请求；
  // 这里只解析明确带文件名的相对路径，实际读取时仍由 safePath 再做边界校验。
  if (!/(下载|导出|聊天窗口|发给我|发送给我|供我下载|download|export|send|copy)/i.test(prompt)) return null;
  const matches = [
    ...prompt.matchAll(/`([^`]+\.[A-Za-z0-9]+)`/g),
    ...prompt.matchAll(/[""']([^""']+\.[A-Za-z0-9]+)[""']/g),
    ...prompt.matchAll(/(?:请\s*)?(?:将|把)?\s*([A-Za-z0-9_\-./\u4e00-\u9fa5]+?)\s*(?:中|里|下|目录中|目录里|目录下)的\s*([A-Za-z0-9_\-.\u4e00-\u9fa5]+\.[A-Za-z0-9]+)/gi),
    ...prompt.matchAll(/(?:文件|file)\s*[`"'""‘’]?([A-Za-z0-9_\-./\u4e00-\u9fa5]+\.[A-Za-z0-9]+)[`"'""‘’]?/gi)
  ];
  const candidates = matches.flatMap((match) => {
    const first = normalizeStructureToken(match[1] ?? "");
    const second = normalizeStructureToken(match[2] ?? "");
    return second ? [normalizeStructureToken(`${first}/${second}`)] : [first];
  });
  const filePath = candidates.find(isSafeWorkspaceFilePath);
  return filePath ? { filePath } : null;
}

/**
 * 功能：提取`current` Markdown 内容 `save` 计划。
 * 输入：`prompt`（string）提供提示词。
 * 输出：返回 WorkspaceCurrentMarkdownSavePlan | null，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.test.ts 顶层流程` 调用；内部调用 `test()`、`matchAll()`、`find()`、`normalizeStructureToken()`。
 */
export function extractCurrentMarkdownSavePlan(prompt: string): WorkspaceCurrentMarkdownSavePlan | null {
  // 处理"将当前这段 Markdown 内容存成 xxx.md 文件"的请求。
  // 这里要求目标文件名明确出现在当前 prompt 中，避免把历史上下文或普通说明误写入工作区。
  if (!/^#\s+/.test(prompt.trim())) return null;
  const matches = [
    ...prompt.matchAll(/(?:将|把)?(?:本文|本文件|内容|以上内容)?\s*(?:存成|保存为|写入到|写成)\s*[`"'""‘’]?([A-Za-z0-9_\-./\u4e00-\u9fa5]+\.md)[`"'""‘’]?\s*(?:文件)?/gi),
    ...prompt.matchAll(/(?:save|write)\s+(?:this\s+)?(?:content|markdown|document)?\s+(?:as|to)\s+[`"'""‘’]?([A-Za-z0-9_\-./]+\.md)[`"'""‘’]?/gi)
  ];
  const filePath = matches.map((match) => normalizeStructureToken(match[1] ?? "")).find(isSafeWorkspaceFilePath);
  return filePath ? { filePath, content: `${prompt.trim()}\n` } : null;
}

/**
 * 功能：判断是否为工作区 `clear` 请求。
 * 输入：`prompt`（string）提供提示词。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `some()`、`test()`。
 */
export function isWorkspaceClearRequest(prompt: string) {
  const normalized = prompt.trim();
  return [
    /清空.*(?:工作区|工作空间|workspace|项目|工程|代码)/i,
    /(?:工作区|工作空间|workspace|项目|工程).*(?:全部清空|清空|删空|全部删除)/i,
    /(?:empty|clear|wipe|delete all).*(?:workspace|project)/i
  ].some((pattern) => pattern.test(normalized));
}

/**
 * 功能：应用`current` Markdown 内容 `save` 计划。
 * 输入：`workspaceRoot`（string）提供工作区 根目录。 `plan`（WorkspaceCurrentMarkdownSavePlan）提供计划。
 * 输出：返回 Promise<WorkspaceCurrentMarkdownSaveResult>，供调用方继续处理。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `assertNoSymlinkPath()`、`ensureSafeParentDirectory()`、`safePathResolve()`、`catch()`、`then()`、`stat()`。
 */
export async function applyCurrentMarkdownSavePlan(workspaceRoot: string, plan: WorkspaceCurrentMarkdownSavePlan): Promise<WorkspaceCurrentMarkdownSaveResult> {
  await assertNoSymlinkPath(workspaceRoot, plan.filePath);
  await ensureSafeParentDirectory(workspaceRoot, plan.filePath);
  const resolvedFile = safePathResolve(workspaceRoot, plan.filePath);
  const exists = await fs.stat(resolvedFile).then((stat) => stat.isFile()).catch(() => false);
  await fs.writeFile(resolvedFile, plan.content, { encoding: "utf8" });
  return {
    filePath: plan.filePath,
    action: exists ? "replaced" : "created"
  };
}

/**
 * 功能：清理工作区 `contents`。
 * 输入：`workspaceRoot`（string）提供工作区 根目录。
 * 输出：返回 Promise<WorkspaceClearResult>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:startNewAgentChat()` 调用；内部调用 `safePathResolve()`、`readdir()`、`isSymbolicLink()`、`unlink()`、`rm()`。
 */
export async function clearWorkspaceContents(workspaceRoot: string): Promise<WorkspaceClearResult> {
  const resolvedRoot = safePathResolve(workspaceRoot, ".");
  const entries = await fs.readdir(resolvedRoot, { withFileTypes: true });
  const deletedEntries: string[] = [];

  for (const entry of entries) {
    const relativePath = entry.name;
    const resolvedEntry = safePathResolve(workspaceRoot, relativePath);
    if (entry.isSymbolicLink()) {
      await fs.unlink(resolvedEntry);
    } else {
      await fs.rm(resolvedEntry, { recursive: true, force: true });
    }
    deletedEntries.push(relativePath);
  }

  return { deletedEntries };
}

/**
 * 功能：应用工作区 `structure` 计划。
 * 输入：`workspaceRoot`（string）提供工作区 根目录。 `plan`（WorkspaceStructurePlan）提供计划。
 * 输出：返回 Promise<WorkspaceStructureResult>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/workspaces/scaffold.service.test.ts 顶层流程` 调用；内部调用 `sort()`、`unique()`、`localeCompare()`、`assertNoSymlinkPath()`、`safePathResolve()`、`catch()`。
 */
export async function applyWorkspaceStructurePlan(workspaceRoot: string, plan: WorkspaceStructurePlan): Promise<WorkspaceStructureResult> {
  const createdDirectories: string[] = [];
  const existingDirectories: string[] = [];
  const createdFiles: string[] = [];
  const existingFiles: string[] = [];

  for (const directory of unique(plan.directories).sort((a, b) => a.localeCompare(b))) {
    await assertNoSymlinkPath(workspaceRoot, directory);
    const resolvedDirectory = safePathResolve(workspaceRoot, directory);
    const existing = await fs.stat(resolvedDirectory).then((stat) => stat.isDirectory()).catch(() => false);
    if (existing) {
      existingDirectories.push(directory);
      continue;
    }
    await fs.mkdir(resolvedDirectory, { recursive: true });
    createdDirectories.push(directory);
  }

  for (const file of plan.files) {
    await assertNoSymlinkPath(workspaceRoot, file.path);
    await ensureSafeParentDirectory(workspaceRoot, file.path);
    const resolvedFile = safePathResolve(workspaceRoot, file.path);
    const exists = await fs.stat(resolvedFile).then((stat) => stat.isFile()).catch(() => false);
    if (exists) {
      existingFiles.push(file.path);
      continue;
    }
    await fs.writeFile(resolvedFile, file.content, { encoding: "utf8", flag: "wx" });
    createdFiles.push(file.path);
  }

  return {
    createdDirectories,
    existingDirectories,
    createdFiles,
    existingFiles
  };
}

/**
 * 功能：应用工作区 `delete` 计划。
 * 输入：`workspaceRoot`（string）提供工作区 根目录。 `plan`（WorkspaceDeletePlan）提供计划。
 * 输出：返回 Promise<WorkspaceDeleteResult>，供调用方继续处理。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `sort()`、`unique()`、`localeCompare()`、`assertNoSymlinkPath()`、`safePathResolve()`、`catch()`。
 */
export async function applyWorkspaceDeletePlan(workspaceRoot: string, plan: WorkspaceDeletePlan): Promise<WorkspaceDeleteResult> {
  const deletedDirectories: string[] = [];
  const missingDirectories: string[] = [];

  for (const directory of unique(plan.directories).sort((a, b) => b.length - a.length || a.localeCompare(b))) {
    await assertNoSymlinkPath(workspaceRoot, directory);
    const resolvedDirectory = safePathResolve(workspaceRoot, directory);
    const exists = await fs.stat(resolvedDirectory).then((stat) => stat.isDirectory()).catch(() => false);
    if (!exists) {
      missingDirectories.push(directory);
      continue;
    }
    await fs.rm(resolvedDirectory, { recursive: true, force: true });
    deletedDirectories.push(directory);
  }

  return {
    deletedDirectories,
    missingDirectories
  };
}
