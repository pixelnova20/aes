/**
 * 文件作用：编排后端“代码符号导航”应用编排层用例及其跨模块调用。
 * 模块位置：`apps/server/src/application/code-navigation/code-navigation-application.service.ts`，属于后端“代码符号导航”应用编排层。
 * 重要函数：`regenerateWorkspaceCodeNavigation()` 负责处理`regenerate` 工作区 代码 `navigation`；`findWorkspaceCodeDefinitions()` 负责查找工作区 代码 定义列表。
 */
import {
  findCodeDefinitions,
  regenerateTags,
} from "../../modules/code-navigation/index.js";
import { getReadyWorkspaceForUser } from "../../modules/workspaces/index.js";

/**
 * 功能：处理`regenerate` 工作区 代码 `navigation`。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/code-navigation.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspaceForUser()`、`regenerateTags()`。
 */
export async function regenerateWorkspaceCodeNavigation(userId: string) {
  const workspace = await getReadyWorkspaceForUser(userId);
  return regenerateTags(workspace.path);
}

/**
 * 功能：查找工作区 代码 定义列表。
 * 输入：`userId`（string）提供用户 id。 `file`（string）提供文件。 `word`（string）提供word。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/code-navigation.router.ts 顶层流程` 调用；内部调用 `getReadyWorkspaceForUser()`、`findCodeDefinitions()`。
 */
export async function findWorkspaceCodeDefinitions(
  userId: string,
  file: string,
  word: string,
) {
  const workspace = await getReadyWorkspaceForUser(userId);
  return findCodeDefinitions(workspace.path, file, word);
}
