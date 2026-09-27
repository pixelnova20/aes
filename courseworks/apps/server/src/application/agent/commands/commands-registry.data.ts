/**
 * 文件作用：声明后端“Agent 用例”应用编排层使用的静态数据。
 * 模块位置：`apps/server/src/application/agent/commands/commands-registry.data.ts`，属于后端“Agent 用例”应用编排层。
 * 重要函数：`buildBuiltinChatCommands()` 负责构建`builtin` 聊天 命令列表；`assertNoDuplicateAliases()` 负责断言并校验`no` `duplicate` `aliases`；`getChatCommands()` 负责获取聊天 命令列表。
 */
// 对齐 OpenClaw src/auto-reply/commands-registry.shared.ts buildBuiltinChatCommands()
// 课程作业平台目前支持的斜杠命令

import { defineChatCommand } from "./commands-registry.shared.js";
import type { ChatCommandDefinition } from "./commands-registry.types.js";

let cachedCommands: ChatCommandDefinition[] | null = null;

/**
 * 功能：构建`builtin` 聊天 命令列表。
 * 输入：无显式输入参数。
 * 输出：返回 ChatCommandDefinition[]，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/agent/commands/commands-registry.data.ts:getChatCommands()` 调用；内部调用 `defineChatCommand()`、`assertNoDuplicateAliases()`。
 */
export function buildBuiltinChatCommands(): ChatCommandDefinition[] {
  const commands: ChatCommandDefinition[] = [
    defineChatCommand({
      key: "new",
      description: "重置会话并清空工作区，开始新课业。",
      textAliases: ["/new"],
      acceptsArgs: false,
      category: "session",
    }),
    defineChatCommand({
      key: "compact",
      description: "压缩当前会话的对话历史。",
      textAliases: ["/compact"],
      acceptsArgs: false,
      category: "session",
    }),
    defineChatCommand({
      key: "context",
      description: "查看当前会话上下文摘要。",
      textAliases: ["/context"],
      acceptsArgs: false,
      category: "status",
    }),
    defineChatCommand({
      key: "tools",
      description: "列出当前可用的 Agent 工具。",
      textAliases: ["/tools"],
      acceptsArgs: false,
      category: "tools",
    }),
  ];

  assertNoDuplicateAliases(commands);
  return commands;
}

/**
 * 功能：断言并校验`no` `duplicate` `aliases`。
 * 输入：`commands`（ChatCommandDefinition[]）提供命令列表。
 * 输出：返回 void，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/agent/commands/commands-registry.data.ts:buildBuiltinChatCommands()` 调用；内部调用 `toLowerCase()`、`has()`、`add()`。
 */
function assertNoDuplicateAliases(commands: ChatCommandDefinition[]): void {
  const seen = new Set<string>();
  for (const cmd of commands) {
    for (const alias of cmd.textAliases) {
      const lowered = alias.toLowerCase();
      if (seen.has(lowered)) {
        throw new Error(`Duplicate command alias: ${alias} (key=${cmd.key})`);
      }
      seen.add(lowered);
    }
  }
}

/**
 * 功能：获取聊天 命令列表。
 * 输入：无显式输入参数。
 * 输出：返回 ChatCommandDefinition[]，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/agent/commands/commands-registry.ts:getCommandDetection()`、`apps/server/src/application/agent/commands/commands-registry.ts:resolveTextCommand()`、`apps/server/src/application/agent/commands/commands-registry.ts:listChatCommands()` 调用；内部调用 `buildBuiltinChatCommands()`。
 */
export function getChatCommands(): ChatCommandDefinition[] {
  if (cachedCommands) return cachedCommands;
  cachedCommands = buildBuiltinChatCommands();
  return cachedCommands;
}
