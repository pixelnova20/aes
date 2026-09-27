/**
 * 文件作用：实现后端“代码符号导航”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/code-navigation/code-navigation.service.ts`，属于后端“代码符号导航”业务模块。
 * 重要函数：`parseCtagsLine()` 负责解析`ctags` `line`；`generateTagsFile()` 负责处理`generate` 符号索引 文件；`loadTagsFile()` 负责加载符号索引 文件；`regenerateTags()` 负责处理`regenerate` 符号索引；`findCodeDefinitions()` 负责查询符号定义并优先返回当前文件之外的匹配项。
 */
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TAGS_FILENAME = ".tags";

type CtagsEntry = {
  name: string;
  file: string;
  line: number;
  kind: string;
};

export type CodeDefinition = CtagsEntry;

/**
 * 功能：解析`ctags` `line`。
 * 输入：`line`（string）提供line。
 * 输出：返回 CtagsEntry | null，供调用方继续处理。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `split()`、`startsWith()`、`parseInt()`。
 */
function parseCtagsLine(line: string): CtagsEntry | null {
  const parts = line.split("\t");
  if (parts.length < 3) return null;

  const name = parts[0];
  const file = parts[1];
  let kind = "";
  let lineNumber = 0;
  for (const part of parts) {
    if (part.startsWith("kind:")) kind = part.slice(5);
    if (part.startsWith("line:")) lineNumber = Number.parseInt(part.slice(5), 10);
  }
  if (!name || !file || !lineNumber) return null;
  return { name, file, line: lineNumber, kind };
}

/**
 * 功能：处理`generate` 符号索引 文件。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回 Promise<boolean>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/code-navigation/code-navigation.service.ts:loadTagsFile()`、`apps/server/src/modules/code-navigation/code-navigation.service.ts:regenerateTags()` 调用；内部调用 `execFileAsync()`。
 */
async function generateTagsFile(workspacePath: string): Promise<boolean> {
  const tagsPath = path.join(workspacePath, "..", TAGS_FILENAME);
  try {
    await execFileAsync(
      "ctags",
      [
        "-f",
        tagsPath,
        "--excmd=number",
        "--fields=+nK",
        "--languages=C,C++,Python,Asm",
        "-R",
        workspacePath,
      ],
      { timeout: 15_000, maxBuffer: 5 * 1024 * 1024 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 功能：加载符号索引 文件。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回 Promise<CtagsEntry[]>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/code-navigation/code-navigation.service.ts:findCodeDefinitions()` 调用；内部调用 `access()`、`generateTagsFile()`、`readFile()`、`split()`。
 */
async function loadTagsFile(workspacePath: string): Promise<CtagsEntry[]> {
  const tagsPath = path.join(workspacePath, "..", TAGS_FILENAME);
  try {
    await access(tagsPath);
  } catch {
    await generateTagsFile(workspacePath);
  }

  try {
    const content = await readFile(tagsPath, "utf8");
    return content
      .split("\n")
      .map(parseCtagsLine)
      .filter((entry): entry is CtagsEntry => entry !== null);
  } catch {
    return [];
  }
}

/**
 * 功能：处理`regenerate` 符号索引。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回 Promise<boolean>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/code-navigation/code-navigation-application.service.ts:regenerateWorkspaceCodeNavigation()` 调用；内部调用 `generateTagsFile()`。
 */
export async function regenerateTags(workspacePath: string): Promise<boolean> {
  return generateTagsFile(workspacePath);
}

/**
 * 功能：查询符号定义并优先返回当前文件之外的匹配项。
 * 输入：`workspacePath`（string）提供工作区 路径。 `file`（string）提供文件。 `word`（string）提供word。
 * 输出：返回 Promise<CodeDefinition[]>，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/code-navigation/code-navigation-application.service.ts:findWorkspaceCodeDefinitions()`、`apps/server/src/modules/code-navigation/code-navigation.service.test.ts 顶层流程` 调用；内部调用 `loadTagsFile()`、`endsWith()`、`startsWith()`、`relativePath()`、`isAbsolute()`。
 */
export async function findCodeDefinitions(
  workspacePath: string,
  file: string,
  word: string,
): Promise<CodeDefinition[]> {
  if (!word) return [];

  const entries = await loadTagsFile(workspacePath);
  const prefix = workspacePath.endsWith(path.sep) ? workspacePath : `${workspacePath}${path.sep}`;
  /**
   * 功能：处理`relative` 路径。
   * 输入：`candidate`（string）提供candidate。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/code-navigation/code-navigation.service.ts:findCodeDefinitions()` 调用；内部调用 `startsWith()`。
   */
  const relativePath = (candidate: string) =>
    candidate.startsWith(prefix) ? candidate.slice(prefix.length) : candidate;
  const queryFile = relativePath(path.isAbsolute(file) ? file : path.join(workspacePath, file));
  const matches = entries.filter((entry) => entry.name === word);
  const external = matches.filter((entry) => relativePath(entry.file) !== queryFile);
  const local = matches.filter((entry) => relativePath(entry.file) === queryFile);

  return [...external, ...local].slice(0, 20).map((entry) => ({
    ...entry,
    file: relativePath(entry.file),
  }));
}
