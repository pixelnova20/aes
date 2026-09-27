/**
 * 文件作用：提供前端“工作台”功能模块复用的辅助能力。
 * 模块位置：`apps/web/src/features/workspace/workspace-utils.ts`，属于前端“工作台”功能模块。
 * 重要函数：`parseAgentResponse()` 负责解析Agent 响应；`extractChatArtifactDownloads()` 负责提取聊天 产物 `downloads`；`stripChatArtifactDownloadMarkers()` 负责处理`strip` 聊天 产物 `download` `markers`；`prefersChinese()` 负责处理`prefers` `chinese`；`nextStreamingTextFrame()` 负责平滑补齐流式文本；`filesFromClipboardData()` 负责从剪贴板中提取不重复的文件；`readFileAsBase64()` 负责读取文件 `as` `base64`；`formatUploadSize()` 负责格式化上传附件 `size`；`formatTokenCount()` 负责格式化Token `count`；`formatAgentContextUsage()` 负责格式化Agent 上下文 占用信息。
 */
import {
  buildAgentRunActivity,
  displayAgentTraceStep,
  toolNameFromTraceStep,
} from "./agent-run-activity";
import type {
  AgentContextUsage,
  AgentRunView,
  ChatArtifactDownload,
  ChatEntry,
  ChatSessionSnapshot,
  ViewKey,
} from "./workspace-types";

const ARTIFACT_DOWNLOAD_MARKER = /\[\[courseworks-artifact-download:([^:\]]+):([^\]]+)\]\]/g;
const THINKING_START = "<!-- courseworks-thinking:start -->";
const THINKING_END = "<!-- courseworks-thinking:end -->";

/**
 * 功能：解析Agent 响应。
 * 输入：`value`（string | null | undefined）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/workspace-utils.test.ts 顶层流程`、`apps/web/src/features/workspace/workspace-utils.ts:restoredRunStatus()`、`apps/web/src/features/workspace/workspace-utils.ts:assistantEntryForRun()`、`apps/web/src/features/workspace/workspace-utils.ts:formatRunProgress()` 调用；内部调用 `indexOf()`。
 */
export function parseAgentResponse(value: string | null | undefined) {
  const markdown = value ?? "";
  const start = markdown.indexOf(THINKING_START);
  if (start < 0) return { thinking: "", content: markdown };
  const end = markdown.indexOf(THINKING_END, start + THINKING_START.length);
  if (end < 0) return { thinking: "", content: markdown };
  return {
    thinking: markdown.slice(start + THINKING_START.length, end).trim(),
    content: `${markdown.slice(0, start)}${markdown.slice(end + THINKING_END.length)}`.trim(),
  };
}

/**
 * 功能：提取聊天 产物 `downloads`。
 * 输入：`content`（string）提供content。
 * 输出：返回 ChatArtifactDownload[]，供调用方继续处理。
 * 调用关系：由 `apps/web/src/features/workspace/AssistantPanel.tsx:renderMessage()` 调用；内部调用 `matchAll()`。
 */
export function extractChatArtifactDownloads(content: string): ChatArtifactDownload[] {
  return [...content.matchAll(ARTIFACT_DOWNLOAD_MARKER)].map((match) => ({
    artifactId: match[1],
    fileName: match[2],
  }));
}

/**
 * 功能：处理`strip` 聊天 产物 `download` `markers`。
 * 输入：`content`（string）提供content。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/AssistantPanel.tsx:renderMessage()` 调用；内部调用 `replace()`。
 */
export function stripChatArtifactDownloadMarkers(content: string) {
  return content.replace(ARTIFACT_DOWNLOAD_MARKER, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * 功能：处理`prefers` `chinese`。
 * 输入：`value`（string）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:loadAgentRuns()`、`apps/web/src/features/workspace/WorkspacePage.tsx:loadChatSession()`、`apps/web/src/features/workspace/WorkspacePage.tsx:loadAgentRun()`、`apps/web/src/features/workspace/WorkspacePage.tsx:submitChat()`、`apps/web/src/features/workspace/WorkspacePage.tsx:startNewChatSession()` 调用；内部调用 `test()`。
 */
export function prefersChinese(value: string) {
  return /[\u3400-\u9fff]/u.test(value);
}

/**
 * 功能：压缩登录恢复时的 Agent 会话历史。
 * 输入：`entries`（ChatSessionSnapshot['history'][]）提供后端返回的会话消息。
 * 输出：返回按 `runId` 合并后的历史；同一 Agent Run 的多个 assistant 中间消息只保留最后一条。
 * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:loadChatSession()`、`apps/web/src/features/workspace/WorkspacePage.tsx:startNewChatSession()` 调用。
 */
export function collapseAgentRunHistory(
  entries: readonly ChatSessionSnapshot["history"][number][],
) {
  const collapsed: ChatSessionSnapshot["history"] = [];
  const assistantIndexByRun = new Map<string, number>();

  for (const entry of entries) {
    if (entry.role !== "assistant" || !entry.runId) {
      collapsed.push(entry);
      continue;
    }

    const previousIndex = assistantIndexByRun.get(entry.runId);
    if (previousIndex === undefined) {
      assistantIndexByRun.set(entry.runId, collapsed.length);
      collapsed.push(entry);
    } else {
      collapsed[previousIndex] = entry;
    }
  }

  return collapsed;
}

/**
 * 功能：筛选当前聊天会话的 Agent 运行记录。
 * 输入：`runs`（AgentRunView[]）提供用户的运行记录；`session`（ChatSessionSnapshot | null）提供当前会话快照；`liveHistory`（ChatEntry[]）提供尚未重新从后端读取的前端聊天记录。
 * 输出：返回属于当前活动聊天会话的运行记录；旧会话的运行记录仍保留在后端，但不在当前会话的工作区列表中显示。
 * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `Set()`、`filter()`。
 */
export function filterAgentRunsForChatSession(
  runs: readonly AgentRunView[],
  session: ChatSessionSnapshot | null,
  liveHistory: readonly Pick<ChatEntry, "runId">[] = [],
) {
  if (!session?.session) return [];

  const runIds = new Set<string>();
  for (const entry of session.history) {
    if (entry.runId) runIds.add(entry.runId);
  }
  for (const entry of liveHistory) {
    if (entry.runId) runIds.add(entry.runId);
  }

  return runs.filter((run) => runIds.has(run.id));
}

/** Advance an appended streaming response in a few readable chunks between server polls. */
export function nextStreamingTextFrame(current: string, target: string) {
  if (!target.startsWith(current)) return target;
  const remaining = Array.from(target.slice(current.length));
  if (!remaining.length) return target;
  const step = Math.max(3, Math.ceil(remaining.length / 8));
  return current + remaining.slice(0, step).join("");
}

/**
 * Extract pasted files from the browser's two views of the same clipboard payload.
 * `items` is authoritative when it contains files; `files` is only a compatibility fallback.
 */
export function filesFromClipboardData(data: Pick<DataTransfer, "items" | "files">): File[] {
  const itemFiles = Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));

  if (itemFiles.length) return itemFiles;
  return Array.from(data.files).filter((file) => file instanceof File);
}

/**
 * 功能：读取文件 `as` `base64`。
 * 输入：`file`（File）提供文件。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:uploadConversationAttachments()` 调用；内部调用 `reject()`、`indexOf()`、`resolve()`、`readAsDataURL()`。
 */
export function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("无法读取本地文件。"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("无法读取本地文件。"));
        return;
      }
      const commaIndex = reader.result.indexOf(",");
      resolve(commaIndex >= 0 ? reader.result.slice(commaIndex + 1) : reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/**
 * 功能：格式化上传附件 `size`。
 * 输入：`bytes`（number）提供bytes。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/AssistantPanel.tsx:AssistantPanel()`、`apps/web/src/features/workspace/WorkspaceDialogs.tsx:WorkspaceImportDialog()` 调用；内部调用 `toFixed()`。
 */
export function formatUploadSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 功能：格式化Token `count`。
 * 输入：`count`（number）提供count。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/workspace-utils.test.ts 顶层流程`、`apps/web/src/features/workspace/workspace-utils.ts:formatAgentContextUsage()` 调用；内部调用 `toString()`、`toFixed()`、`round()`。
 */
export function formatTokenCount(count: number) {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}K`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}K`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/**
 * 功能：格式化Agent 上下文 占用信息。
 * 输入：`usage`（AgentContextUsage | null | undefined）提供占用信息。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/AssistantPanel.tsx:AssistantPanel()`、`apps/web/src/features/workspace/workspace-utils.test.ts 顶层流程` 调用；内部调用 `formatTokenCount()`、`toFixed()`。
 */
export function formatAgentContextUsage(usage: AgentContextUsage | null | undefined) {
  if (!usage || usage.contextWindow <= 0) return "--";
  const tokens = usage.tokens === null ? "?" : formatTokenCount(usage.tokens);
  const percent = usage.percent === null ? "?" : `${usage.percent.toFixed(1)}%`;
  return `${tokens}/${formatTokenCount(usage.contextWindow)} · ${percent}`;
}

export type PromptHistoryNavigation = {
  index: number | null;
  draft: string;
};

const TEXTAREA_CARET_STYLE_PROPERTIES = [
  "direction",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "letter-spacing",
  "line-height",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "tab-size",
  "text-align",
  "text-indent",
  "text-transform",
  "word-break",
  "word-spacing",
] as const;

/**
 * 功能：处理`textarea` `caret` `top`。
 * 输入：`textarea`（HTMLTextAreaElement）提供textarea。 `position`（number）提供position。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/workspace-utils.ts:isPromptHistoryVisualBoundary()` 调用；内部调用 `createElement()`、`getComputedStyle()`、`setProperty()`、`getPropertyValue()`、`append()`、`remove()`。
 */
function textareaCaretTop(textarea: HTMLTextAreaElement, position: number) {
  const mirror = document.createElement("div");
  const marker = document.createElement("span");
  const styles = window.getComputedStyle(textarea);
  for (const property of TEXTAREA_CARET_STYLE_PROPERTIES) {
    mirror.style.setProperty(property, styles.getPropertyValue(property));
  }
  mirror.style.position = "fixed";
  mirror.style.left = "-10000px";
  mirror.style.top = "0";
  mirror.style.boxSizing = "border-box";
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.minHeight = "0";
  mirror.style.maxHeight = "none";
  mirror.style.height = "auto";
  mirror.style.overflow = "hidden";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = textarea.wrap === "off" ? "pre" : "pre-wrap";
  mirror.style.overflowWrap = textarea.wrap === "off" ? "normal" : "break-word";
  mirror.textContent = textarea.value.slice(0, position);
  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  return top;
}

/**
 * 功能：判断是否为提示词 历史记录 `visual` `boundary`。
 * 输入：`textarea`（HTMLTextAreaElement）提供textarea。 `direction`（"older" | "newer"）提供direction。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:handleChatPromptKeyDown()` 调用；内部调用 `textareaCaretTop()`、`abs()`。
 */
export function isPromptHistoryVisualBoundary(
  textarea: HTMLTextAreaElement,
  direction: "older" | "newer",
) {
  if (textarea.selectionStart !== textarea.selectionEnd) return false;
  if (textarea.clientWidth <= 0) return false;
  const currentTop = textareaCaretTop(textarea, textarea.selectionStart);
  const boundaryTop = textareaCaretTop(
    textarea,
    direction === "older" ? 0 : textarea.value.length,
  );
  return Math.abs(currentTop - boundaryTop) < 0.5;
}

/**
 * 功能：处理`navigate` 提示词 历史记录。
 * 输入：`history`（readonly string[]）提供历史记录。 `currentValue`（string）提供current value。 `navigation`（PromptHistoryNavigation）提供navigation。 `direction`（"older" | "newer"）提供direction。
 * 输出：返回 { value: string; navigation: PromptHistoryNavigation } | null，供调用方继续处理。
 * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:handleChatPromptKeyDown()`、`apps/web/src/features/workspace/workspace-utils.test.ts 顶层流程` 调用；内部调用 `max()`。
 */
export function navigatePromptHistory(
  history: readonly string[],
  currentValue: string,
  navigation: PromptHistoryNavigation,
  direction: "older" | "newer",
): { value: string; navigation: PromptHistoryNavigation } | null {
  if (history.length === 0) return null;

  if (direction === "older") {
    const index = navigation.index === null
      ? history.length - 1
      : Math.max(0, navigation.index - 1);
    return {
      value: history[index],
      navigation: {
        index,
        draft: navigation.index === null ? currentValue : navigation.draft,
      },
    };
  }

  if (navigation.index === null) return null;
  if (navigation.index < history.length - 1) {
    const index = navigation.index + 1;
    return {
      value: history[index],
      navigation: { ...navigation, index },
    };
  }
  return {
    value: navigation.draft,
    navigation: { index: null, draft: "" },
  };
}

/**
 * 功能：判断是否为`terminal` 运行。
 * 输入：`run`（AgentRunView | null | undefined）提供运行。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:loadAgentRuns()`、`apps/web/src/features/workspace/WorkspacePage.tsx:monitorAgentRun()`、`apps/web/src/features/workspace/workspace-utils.ts:restoredRunStatus()`、`apps/web/src/features/workspace/workspace-utils.ts:assistantEntryForRun()`、`apps/web/src/features/workspace/workspace-utils.ts:formatRunProgress()` 调用；内部调用 `includes()`。
 */
export function isTerminalRun(run: AgentRunView | null | undefined) {
  return Boolean(run?.finishedAt)
    || ["completed", "failed", "cancelled", "build_failed", "qemu_failed", "qemu_success"].includes(run?.status ?? "");
}

/**
 * 功能：处理`restored` 运行 状态。
 * 输入：`run`（AgentRunView）提供运行。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:toggleChatActivity()`、`apps/web/src/features/workspace/workspace-utils.ts:assistantEntryForRun()` 调用；内部调用 `parseAgentResponse()`、`isTerminalRun()`。
 */
export function restoredRunStatus(run: AgentRunView) {
  const streamed = parseAgentResponse(run.responseMarkdown);
  if (!isTerminalRun(run)) {
    return run.finalAnswerMarkdown || streamed.content || "正在处理工作区中的任务...\n\n正在恢复最近保存的任务进度。";
  }
  if (run.status === "failed") {
    return run.finalAnswerMarkdown || run.errorMessage || "The workspace task failed.";
  }
  return run.finalAnswerMarkdown || "The workspace task finished without a text response.";
}

/**
 * 功能：处理`unrecorded` 消息 `suffix`。
 * 输入：`value`（string）提供value。 `run`（AgentRunView）提供运行。 `stepName`（"pi:assistant_message" | "pi:assistant_thinking"）提供step name。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/workspace-utils.ts:assistantEntryForRun()` 调用；内部调用 `isArray()`、`replace()`、`startsWith()`。
 */
function unrecordedMessageSuffix(
  value: string,
  run: AgentRunView,
  stepName: "pi:assistant_message" | "pi:assistant_thinking",
) {
  let remaining = value.trim();
  const traces = Array.isArray(run.traceEvents) ? run.traceEvents : [];
  for (const trace of traces) {
    if (trace.stepName !== stepName) continue;
    const recorded = trace.outputSummaryMarkdown?.replace(/\n\[truncated\]$/, "").trim() || "";
    if (!recorded || !remaining.startsWith(recorded)) continue;
    remaining = remaining.slice(recorded.length).trim();
  }
  return remaining;
}

/**
 * 功能：处理助手消息 `entry` `for` 运行。
 * 输入：`id`（string）提供id。 `run`（AgentRunView）提供运行。
 * 输出：返回 ChatEntry，供调用方继续处理。
 * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:loadAgentRuns()`、`apps/web/src/features/workspace/WorkspacePage.tsx:loadAgentRun()`、`apps/web/src/features/workspace/WorkspacePage.tsx:monitorAgentRun()`、`apps/web/src/features/workspace/workspace-utils.test.ts 顶层流程` 调用；内部调用 `parseAgentResponse()`、`isTerminalRun()`、`restoredRunStatus()`、`unrecordedMessageSuffix()`、`buildAgentRunActivity()`、`prefersChinese()`。
 */
export function assistantEntryForRun(id: string, run: AgentRunView): ChatEntry {
  const streamed = parseAgentResponse(run.responseMarkdown);
  const terminal = isTerminalRun(run);
  const output = run.finalAnswerMarkdown || streamed.content || restoredRunStatus(run);
  const liveText = terminal
    ? output
    : unrecordedMessageSuffix(streamed.content, run, "pi:assistant_message");
  const liveThinking = unrecordedMessageSuffix(
    streamed.thinking,
    run,
    "pi:assistant_thinking",
  );
  // 运行中需要把过程投影到聊天区，结束后只保留最终回答。完整 trace 仍由
  // Agent Run 详情接口保存，避免历史会话反复展开中间过程。
  const runActivity = terminal ? [] : buildAgentRunActivity(run, liveText);
  const activity = runActivity.length ? runActivity : undefined;
  const chinese = prefersChinese(run.prompt || output);
  const pendingFallback = activity?.length
    ? "正在继续处理..."
    : formatRunProgress(run, "");
  if (!terminal) {
    return {
      id,
      role: "assistant",
      content: liveText || pendingFallback,
      thinking: liveThinking || undefined,
      activity,
      runId: run.id,
      chinese,
      pending: true,
    };
  }
  return {
    id,
    role: "assistant",
    content: output.trim() || "任务已结束，但 Pi Agent 没有返回文本消息。",
    runId: run.id,
    chinese,
  };
}

/**
 * 功能：格式化运行 `progress`。
 * 输入：`run`（AgentRunView）提供运行。 `streamedContent`（string）提供streamed content。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/workspace-utils.ts:assistantEntryForRun()` 调用；内部调用 `isTerminalRun()`、`parseAgentResponse()`、`isArray()`、`toolNameFromTraceStep()`、`prefersChinese()`、`displayAgentTraceStep()`。
 */
export function formatRunProgress(run: AgentRunView, streamedContent?: string) {
  if (isTerminalRun(run)) {
    return run.finalAnswerMarkdown || run.responseMarkdown || "工作区任务已结束，但没有返回文本消息。";
  }
  const content = streamedContent ?? parseAgentResponse(run.responseMarkdown).content;
  if (content) return content;
  const traces = Array.isArray(run.traceEvents) ? run.traceEvents : [];
  const lastTools = traces.filter((trace) =>
    typeof trace.stepName === "string"
    && toolNameFromTraceStep(trace.stepName)
    && trace.stepStatus === "success"
  ).slice(-4);
  if (lastTools.length > 0) {
    const toolLines = lastTools.map((trace) => {
      const name = toolNameFromTraceStep(trace.stepName ?? "") || trace.stepName || "tool";
      return `- ${displayAgentTraceStep(`pi:tool:${name}`)}`;
    });
    return `${toolLines.join("\n")}\n\n正在继续处理...`;
  }
  const currentTool = typeof run.currentStep === "string"
    ? toolNameFromTraceStep(run.currentStep)
    : null;
  if (currentTool) return displayAgentTraceStep(`pi:tool:${currentTool}`);
  return "正在分析任务...";
}

/**
 * 功能：处理`language` `from` 路径。
 * 输入：`path`（string）提供路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/WorkspaceEditor.tsx:WorkspaceEditor()` 调用；内部调用 `toLowerCase()`、`pop()`、`split()`、`endsWith()`、`includes()`。
 */
export function languageFromPath(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (path.endsWith("Makefile")) return "makefile";
  if (extension === "c" || extension === "h") return "c";
  if (["cpp", "hpp", "cc", "cxx"].includes(extension)) return "cpp";
  if (["s", "asm"].includes(extension)) return "asm";
  if (["py", "pyw"].includes(extension)) return "python";
  if (extension === "rs") return "rust";
  if (extension === "go") return "go";
  if (extension === "java") return "java";
  if (["js", "jsx"].includes(extension)) return "javascript";
  if (["ts", "tsx"].includes(extension)) return "typescript";
  if (["md", "mdx"].includes(extension)) return "markdown";
  if (extension === "json") return "json";
  if (["yaml", "yml"].includes(extension)) return "yaml";
  if (extension === "toml") return "ini";
  if (["xml", "svg"].includes(extension)) return "xml";
  if (["html", "htm"].includes(extension)) return "html";
  if (["css", "scss", "less"].includes(extension)) return "css";
  if (["sh", "bash", "zsh"].includes(extension)) return "shell";
  return "plaintext";
}

/**
 * 功能：处理`view` `title`。
 * 输入：`view`（ViewKey）提供view。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/WorkspaceSidebar.tsx:WorkspaceSidebar()` 调用。
 */
export function viewTitle(view: ViewKey) {
  return { explorer: "资源管理器", runs: "运行记录", class: "班级" }[view];
}

/**
 * 功能：压缩`compact` 对应的数据。
 * 输入：`value`（string）提供value。 `length`（number）提供length。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:compactAgentChat()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:prepareModelConfiguration()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:compact()`、`apps/web/src/features/workspace/WorkspaceSidebar.tsx:WorkspaceSidebar()` 调用。
 */
export function compact(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

/**
 * 功能：处理状态 `tone`。
 * 输入：`status`（string）提供状态。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/WorkspaceSidebar.tsx:WorkspaceSidebar()` 调用；内部调用 `test()`。
 */
export function statusTone(status: string) {
  if (/success|completed|applied/.test(status)) return "success";
  if (/failed|error/.test(status)) return "error";
  return "running";
}
