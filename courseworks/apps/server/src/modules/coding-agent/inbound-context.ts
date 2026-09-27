/**
 * 文件作用：实现后端“Coding Agent 与 Pi 适配”业务模块中的 `buildUploadMediaNote`、`buildOpenFilesContext`、`buildInboundContext` 等能力。
 * 模块位置：`apps/server/src/modules/coding-agent/inbound-context.ts`，属于后端“Coding Agent 与 Pi 适配”业务模块。
 * 重要函数：`buildUploadMediaNote()` 负责构建上传附件 `media` `note`；`buildOpenFilesContext()` 负责构建`open` 文件列表 上下文；`buildInboundContext()` 负责构建`inbound` 上下文。
 */
// 对齐 OpenClaw：附件和打开文件只标注路径/文件名，不内联内容到 prompt

const MAX_OPEN_FILES = 6;

// ---- 上传附件（对齐 OpenClaw media note） ----

export type UploadMediaEntry = {
  name: string;
  workspacePath: string;      // 文件在 workspace 中的路径（agent 可以 read_file）
};

/** 构建附件标注，对齐 OpenClaw buildInboundMediaNote() */
/**
 * 功能：构建上传附件 `media` `note`。
 * 输入：`media`（UploadMediaEntry[]）提供media。
 * 输出：返回 string，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/agent/commands/inbound.test.ts 顶层流程`、`apps/server/src/modules/coding-agent/inbound-context.ts:buildInboundContext()` 调用。
 */
export function buildUploadMediaNote(media: UploadMediaEntry[]): string {
  if (!media.length) return "";
  if (media.length === 1) {
    return `[media attached: ${media[0].workspacePath}]`;
  }
  const lines = [`[media attached: ${media.length} files]`];
  media.forEach((m, i) => {
    lines.push(`[media attached ${i + 1}/${media.length}: ${m.workspacePath}]`);
  });
  return lines.join("\n");
}

// ---- 编辑器打开文件（对齐 OpenClaw：只列文件名，不内联内容） ----

/**
 * 功能：构建`open` 文件列表 上下文。
 * 输入：`_workspacePath`（string）提供工作区 路径。 `openFiles`（string[]）提供open 文件列表。
 * 输出：返回 string，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:submitAgentPrompt()`、`apps/server/src/application/agent/commands/inbound.test.ts 顶层流程`、`apps/server/src/modules/coding-agent/inbound-context.ts:buildInboundContext()` 调用。
 */
export function buildOpenFilesContext(
  _workspacePath: string,
  openFiles: string[],
): string {
  if (!openFiles.length) return "";
  // Monaco 一次只显示一个文件，所以永远是单数
  return `[open file: ${openFiles[0]}]`;
}

// ---- 综合入站上下文 ----

export type InboundContext = {
  mediaNote: string;
  openFilesContext: string;
};

/**
 * 功能：构建`inbound` 上下文。
 * 输入：`args`（{ workspacePath: string; media?: UploadMediaEntry[]; openFiles?: string[]; }）提供args。
 * 输出：返回 InboundContext，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/agent/commands/inbound.test.ts 顶层流程` 调用；内部调用 `buildOpenFilesContext()`、`buildUploadMediaNote()`。
 */
export function buildInboundContext(args: {
  workspacePath: string;
  media?: UploadMediaEntry[];
  openFiles?: string[];
}): InboundContext {
  const openFilesContext = buildOpenFilesContext(args.workspacePath, args.openFiles ?? []);
  const mediaNote = buildUploadMediaNote(args.media ?? []);
  return { mediaNote, openFilesContext };
}
