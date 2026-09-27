/**
 * 文件作用：定义后端“Agent 用例”应用编排层使用的数据结构与类型契约。
 * 模块位置：`apps/server/src/application/agent/commands/commands-registry.types.ts`，属于后端“Agent 用例”应用编排层。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
// 对齐 OpenClaw src/auto-reply/commands-registry.types.ts
// 课程作业平台只保留 text-only 命令（无 native/both scope 概念）

export type CommandCategory = "session" | "status" | "tools";

export type ChatCommandDefinition = {
  key: string;
  description: string;
  textAliases: string[];
  /** 命令是否接受参数（例如 /new --reason "xxx"） */
  acceptsArgs?: boolean;
  category: CommandCategory;
};

export type CommandNormalizeOptions = {
  botUsername?: string;
};

export type CommandDetection = {
  exact: Set<string>;
  regex: RegExp;
};

export type CommandResolveResult = {
  command: ChatCommandDefinition;
  args?: string;
} | null;

export type CommandHandlerContext = {
  userId: string;
  workspacePath: string;
  mode?: "work" | "review";
  args?: string;
};

export type CommandResult = {
  type: "command";
  key: string;
  markdown: string;
  /** 需要前端执行的副作用（仅 /new 等会用到） */
  sideEffect?: "reset_session" | "none";
};

export type CommandHandler = (ctx: CommandHandlerContext) => Promise<CommandResult>;
