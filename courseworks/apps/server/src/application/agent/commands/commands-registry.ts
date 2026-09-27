/**
 * 文件作用：实现后端“Agent 用例”应用编排层中的 `escapeRegExp`、`getCommandDetection`、`isCommandMessage` 等能力。
 * 模块位置：`apps/server/src/application/agent/commands/commands-registry.ts`，属于后端“Agent 用例”应用编排层。
 * 重要函数：`escapeRegExp()` 负责处理`escape` `reg` `exp`；`getCommandDetection()` 负责获取命令 `detection`；`isCommandMessage()` 负责判断是否为命令 消息；`resolveTextCommand()` 负责解析并确定`text` 命令；`listChatCommands()` 负责列出聊天 命令列表；`invalidateCommandCache()` 负责处理`invalidate` 命令 `cache`。
 */
// 对齐 OpenClaw src/auto-reply/commands-registry.ts
// 提供命令检测、规范化、解析能力

import { getChatCommands } from "./commands-registry.data.js";
import type {
  ChatCommandDefinition,
  CommandDetection,
  CommandResolveResult,
} from "./commands-registry.types.js";

let cachedDetection: CommandDetection | null = null;
let cachedDetectionCommands: ChatCommandDefinition[] | null = null;

/**
 * 功能：处理`escape` `reg` `exp`。
 * 输入：`value`（string）提供value。
 * 输出：返回 string，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/agent/commands/commands-registry.ts:getCommandDetection()` 调用；内部调用 `replace()`。
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 构建命令检测正则，对齐 OpenClaw getCommandDetection() */
/**
 * 功能：获取命令 `detection`。
 * 输入：无显式输入参数。
 * 输出：返回 CommandDetection，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/agent/commands/commands-registry.ts:isCommandMessage()`、`apps/server/src/application/agent/commands/commands-registry.ts:resolveTextCommand()` 调用；内部调用 `getChatCommands()`、`toLowerCase()`、`add()`、`escapeRegExp()`。
 */
export function getCommandDetection(): CommandDetection {
  const commands = getChatCommands();
  if (cachedDetection && cachedDetectionCommands === commands) {
    return cachedDetection;
  }
  const exact = new Set<string>();
  const patterns: string[] = [];
  for (const cmd of commands) {
    for (const alias of cmd.textAliases) {
      const lowered = alias.toLowerCase();
      if (!lowered) continue;
      exact.add(lowered);
      const escaped = escapeRegExp(lowered);
      if (!escaped) continue;
      if (cmd.acceptsArgs) {
        patterns.push(`${escaped}(?:\\s+.+)?`);
      } else {
        patterns.push(escaped);
      }
    }
  }
  cachedDetection = {
    exact,
    regex: patterns.length ? new RegExp(`^(?:${patterns.join("|")})$`, "i") : /$^/,
  };
  cachedDetectionCommands = commands;
  return cachedDetection;
}

/** 检查给定文本是否为已知命令 */
/**
 * 功能：判断是否为命令 消息。
 * 输入：`raw`（string）提供raw。
 * 输出：返回 boolean，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/agent/commands/inbound.test.ts 顶层流程` 调用；内部调用 `startsWith()`、`getCommandDetection()`、`toLowerCase()`、`has()`、`test()`。
 */
export function isCommandMessage(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return false;
  const detection = getCommandDetection();
  const lowered = trimmed.toLowerCase();
  return detection.exact.has(lowered) || detection.regex.test(lowered);
}

/** 解析命令文本，返回匹配的 ChatCommandDefinition 及参数 */
/**
 * 功能：解析并确定`text` 命令。
 * 输入：`raw`（string）提供raw。
 * 输出：返回 CommandResolveResult，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:submitAgentPrompt()`、`apps/server/src/application/agent/commands/inbound.test.ts 顶层流程` 调用；内部调用 `startsWith()`、`getCommandDetection()`、`toLowerCase()`、`has()`、`find()`、`getChatCommands()`。
 */
export function resolveTextCommand(raw: string): CommandResolveResult {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;
  const detection = getCommandDetection();
  const lowered = trimmed.toLowerCase();

  // 精确匹配
  if (detection.exact.has(lowered)) {
    const cmd = getChatCommands().find((c) =>
      c.textAliases.some((a) => a.toLowerCase() === lowered)
    );
    if (cmd) return { command: cmd };
  }

  // 带参数匹配：/command args
  const match = lowered.match(/^(\/[^\s]+)(?:\s+(.+))?$/);
  if (!match) return null;
  const [, token, rest] = match;
  const cmd = getChatCommands().find((c) =>
    c.textAliases.some((a) => a.toLowerCase() === token && c.acceptsArgs)
  );
  if (!cmd) return null;
  return { command: cmd, args: rest?.trim() || undefined };
}

/** 列出所有命令（供 /help 等命令使用） */
/**
 * 功能：列出聊天 命令列表。
 * 输入：无显式输入参数。
 * 输出：返回 ChatCommandDefinition[]，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:knownCommands()` 调用；内部调用 `getChatCommands()`。
 */
export function listChatCommands(): ChatCommandDefinition[] {
  return getChatCommands();
}

/** 使缓存失效（测试用） */
/**
 * 功能：处理`invalidate` 命令 `cache`。
 * 输入：无显式输入参数。
 * 输出：返回 void，供调用方继续处理。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用。
 */
export function invalidateCommandCache(): void {
  cachedDetection = null;
  cachedDetectionCommands = null;
}
