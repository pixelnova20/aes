/**
 * 文件作用：提供后端“Agent 用例”应用编排层复用的辅助能力。
 * 模块位置：`apps/server/src/application/agent/commands/commands-registry.shared.ts`，属于后端“Agent 用例”应用编排层。
 * 重要函数：`defineChatCommand()` 负责处理`define` 聊天 命令。
 */
// 对齐 OpenClaw src/auto-reply/commands-registry.shared.ts defineChatCommand()

import type { ChatCommandDefinition, CommandCategory } from "./commands-registry.types.js";

type DefineChatCommandInput = {
  key: string;
  description: string;
  textAliases: string[];
  acceptsArgs?: boolean;
  category?: CommandCategory;
};

/**
 * 功能：处理`define` 聊天 命令。
 * 输入：`input`（DefineChatCommandInput）提供当前操作所需的结构化输入。
 * 输出：返回 ChatCommandDefinition，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/agent/commands/commands-registry.data.ts:buildBuiltinChatCommands()` 调用。
 */
export function defineChatCommand(input: DefineChatCommandInput): ChatCommandDefinition {
  const aliases = input.textAliases
    .map((alias) => alias.trim())
    .filter(Boolean);
  return {
    key: input.key,
    description: input.description,
    textAliases: aliases,
    acceptsArgs: input.acceptsArgs ?? false,
    category: input.category ?? "tools",
  };
}
