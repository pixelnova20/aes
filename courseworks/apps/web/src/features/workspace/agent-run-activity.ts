/**
 * 文件作用：实现前端“工作台”功能模块中的 `prefersChinese`、`toolNameFromTraceStep`、`displayAgentTraceStep` 等能力。
 * 模块位置：`apps/web/src/features/workspace/agent-run-activity.ts`，属于前端“工作台”功能模块。
 * 重要函数：`prefersChinese()` 负责处理`prefers` `chinese`；`toolNameFromTraceStep()` 负责处理`tool` `name` `from` `trace` `step`；`displayAgentTraceStep()` 负责处理`display` Agent `trace` `step`；`parseJsonObject()` 负责解析`json` `object`；`toolCallId()` 负责处理`tool` `call` `id`；`compactOneLine()` 负责压缩`one` `line`；`formatToolArgs()` 负责格式化`tool` `args`；`toolSummary()` 负责处理`tool` 摘要。
 */
export type AgentRunTraceDetail = {
  id: string;
  stepName: string;
  status: string;
  summary: string;
  detail: string;
  kind: "assistant" | "thinking" | "tool" | "system";
};

type RunTrace = {
  id?: string;
  stepName?: string;
  stepStatus?: string;
  inputSummaryMarkdown?: string | null;
  outputSummaryMarkdown?: string | null;
  errorMarkdown?: string | null;
  debugMarkdown?: string | null;
};

type RunSnapshot = {
  id?: string;
  prompt?: string | null;
  traceEvents?: RunTrace[] | null;
};

type MutableTraceDetail = AgentRunTraceDetail & {
  input: string;
  output: string;
  error: string;
  toolCallId?: string;
};

/**
 * 功能：处理`prefers` `chinese`。
 * 输入：`value`（string）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:loadAgentRuns()`、`apps/web/src/features/workspace/WorkspacePage.tsx:loadChatSession()`、`apps/web/src/features/workspace/WorkspacePage.tsx:loadAgentRun()`、`apps/web/src/features/workspace/WorkspacePage.tsx:submitChat()`、`apps/web/src/features/workspace/WorkspacePage.tsx:startNewChatSession()` 调用；内部调用 `test()`。
 */
function prefersChinese(value: string) {
  return /[\u3400-\u9fff]/.test(value);
}

/**
 * 功能：处理`tool` `name` `from` `trace` `step`。
 * 输入：`step`（string）提供step。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/agent-run-activity.ts:displayAgentTraceStep()`、`apps/web/src/features/workspace/agent-run-activity.ts:toolSummary()`、`apps/web/src/features/workspace/agent-run-activity.ts:buildAgentRunActivity()`、`apps/web/src/features/workspace/workspace-utils.ts:formatRunProgress()` 调用；内部调用 `startsWith()`。
 */
export function toolNameFromTraceStep(step: string) {
  if (step.startsWith("pi:tool:")) return step.slice("pi:tool:".length);
  if (step.startsWith("tool:")) return step.slice("tool:".length);
  return null;
}

/**
 * 功能：处理`display` Agent `trace` `step`。
 * 输入：`step`（string）提供step。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/agent-run-activity.ts:systemSummary()`、`apps/web/src/features/workspace/workspace-utils.ts:formatRunProgress()` 调用；内部调用 `toolNameFromTraceStep()`、`startsWith()`、`replace()`。
 */
export function displayAgentTraceStep(step: string) {
  const toolName = toolNameFromTraceStep(step);
  if (toolName) {
    const labels: Record<string, string> = {
      read_file: "正在读取文件",
      write_file: "正在写入文件",
      list_files: "正在列出文件",
      delete_file: "正在删除文件",
      edit: "正在编辑文件",
      grep: "正在搜索",
      apply_patch: "正在应用补丁",
      make: "正在构建",
      qemu_smoke: "QEMU 冒烟测试",
      exec: "正在执行命令",
      web_search: "正在搜索网页",
      web_fetch: "正在获取网址",
      find: "正在查找文件",
      stop: "正在完成任务",
      read: "正在读取文件",
      write: "正在写入文件",
      bash: "正在运行命令",
    };
    return labels[toolName] || toolName;
  }
  const labels: Record<string, string> = {
    completed: "任务已完成",
    failed: "任务失败",
    session_compacted: "会话已压缩",
    "pi:agent_start": "Agent 已启动",
    "pi:agent_settled": "Agent 已完成",
    "pi:failed": "Pi Agent 运行失败",
  };
  if (step.startsWith("pi:compaction:")) return "正在压缩会话上下文";
  if (step.startsWith("pi:retry:")) return "正在重试模型请求";
  return labels[step] || step.replace(/_/g, " ");
}

/**
 * 功能：解析`json` `object`。
 * 输入：`value`（string | null | undefined）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/agent-run-activity.ts:toolCallId()`、`apps/web/src/features/workspace/agent-run-activity.ts:formatToolArgs()` 调用；内部调用 `replace()`、`parse()`、`isArray()`。
 */
function parseJsonObject(value: string | null | undefined) {
  if (!value) return null;
  const candidates = [
    value.trim().replace(/^Args:\s*/i, "").replace(/^`([\s\S]*)`$/, "$1"),
    value.trim(),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 截断或旧版 Trace payload 继续按纯文本展示，保证历史记录可读。
    }
  }
  return null;
}

/**
 * 功能：处理`tool` `call` `id`。
 * 输入：`trace`（RunTrace）提供trace。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/agent-run-activity.ts:buildAgentRunActivity()` 调用；内部调用 `parseJsonObject()`。
 */
function toolCallId(trace: RunTrace) {
  const debug = parseJsonObject(trace.debugMarkdown);
  return typeof debug?.toolCallId === "string" ? debug.toolCallId : undefined;
}

/**
 * 功能：压缩`one` `line`。
 * 输入：`value`（string）提供value。 `max`提供max。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/agent-run-activity.ts:formatToolArgs()`、`apps/web/src/features/workspace/agent-run-activity.ts:assistantSummary()`、`apps/web/src/features/workspace/agent-run-activity.ts:thinkingSummary()` 调用；内部调用 `replace()`。
 */
function compactOneLine(value: string, max = 120) {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}...` : line;
}

/**
 * 功能：格式化`tool` `args`。
 * 输入：`input`（string）提供当前操作所需的结构化输入。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/agent-run-activity.ts:toolSummary()` 调用；内部调用 `parseJsonObject()`、`compactOneLine()`、`replace()`、`sort()`、`entries()`、`indexOf()`。
 */
function projectRelativePath(value: unknown) {
  if (typeof value !== "string") return "";
  let candidate = value.trim().replace(/^([`'"])([\s\S]*)\1$/, "$2").replace(/\\/g, "/");
  const sandboxRoot = "/home/runner/project";
  if (candidate === sandboxRoot || candidate === "project" || candidate === "./") return ".";
  if (candidate.startsWith(`${sandboxRoot}/`)) candidate = candidate.slice(sandboxRoot.length + 1);
  else {
    const projectMarker = candidate.lastIndexOf("/project/");
    if (projectMarker >= 0) candidate = candidate.slice(projectMarker + "/project/".length);
    else if (candidate.startsWith("project/")) candidate = candidate.slice("project/".length);
  }
  candidate = candidate.replace(/^\.\//, "");
  return compactOneLine(candidate || ".", 92);
}

function patchTargets(value: unknown) {
  if (typeof value !== "string") return [];
  const paths = [...value.matchAll(/^(?:\*\*\* (?:Add|Update|Delete) File:|\+\+\+ b\/|--- a\/)\s*(.+)$/gm)]
    .map((match) => projectRelativePath(match[1]))
    .filter(Boolean);
  return [...new Set(paths)];
}

function formatToolArgs(toolName: string, input: string) {
  const args = parseJsonObject(input);
  if (!args) return compactOneLine(input.replace(/^`|`$/g, ""), 100);
  const pathValue = args.path ?? args.file_path ?? args.filePath ?? args.target_path ?? args.targetPath;
  const path = projectRelativePath(pathValue);
  const fileTools = new Set(["read", "write", "edit", "read_file", "write_file", "delete_file"]);
  if (fileTools.has(toolName) && path) {
    const editCount = Array.isArray(args.edits) ? args.edits.length : 0;
    return editCount ? `${path} · ${editCount} 处编辑` : path;
  }

  if (["bash", "exec", "make"].includes(toolName) && typeof args.command === "string") {
    return compactOneLine(args.command, 100);
  }

  if (toolName === "apply_patch") {
    const targets = patchTargets(args.patch ?? args.input ?? args.content);
    if (targets.length) {
      const visible = targets.slice(0, 2).join(", ");
      return targets.length > 2 ? `${visible} · 另有 ${targets.length - 2} 个文件` : visible;
    }
  }

  const query = args.pattern ?? args.query;
  if (typeof query === "string") {
    const target = path || projectRelativePath(args.directory ?? args.cwd);
    return `${compactOneLine(query, 72)}${target ? ` · ${target}` : ""}`;
  }
  if (path) return path;

  return Object.entries(args)
    .filter(([key, value]) => !["content", "edits", "patch", "input"].includes(key)
      && ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 2)
    .map(([key, value]) => `${key}=${compactOneLine(String(value), 72)}`)
    .join(" · ");
}

/**
 * 功能：处理`tool` 摘要。
 * 输入：`detail`（MutableTraceDetail）提供detail。 `chinese`（boolean）提供chinese。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/agent-run-activity.ts:buildAgentRunActivity()` 调用；内部调用 `toolNameFromTraceStep()`、`formatToolArgs()`。
 */
function toolSummary(detail: MutableTraceDetail, _chinese: boolean) {
  const toolName = toolNameFromTraceStep(detail.stepName) || detail.stepName;
  const labels: Record<string, string> = {
    read_file: "read",
    write_file: "write",
    list_files: "ls",
    delete_file: "rm",
    edit: "edit",
    grep: "grep",
    apply_patch: "patch",
    make: "make",
    qemu_smoke: "qemu",
    exec: "exec",
    web_search: "search",
    web_fetch: "fetch",
    find: "find",
    stop: "done",
  };
  const status = detail.status === "running"
    ? "执行中"
    : detail.status === "failed"
      ? "失败"
      : "完成";
  const args = formatToolArgs(toolName, detail.input);
  return `${status} · ${labels[toolName] || toolName}${args ? ` · ${args}` : ""}`;
}

/**
 * 功能：处理助手消息 摘要。
 * 输入：`output`（string）提供输出。 `chinese`（boolean）提供chinese。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/agent-run-activity.ts:buildAgentRunActivity()` 调用；内部调用 `compactOneLine()`。
 */
function assistantSummary(output: string, _chinese: boolean) {
  const preview = compactOneLine(output, 120);
  return `Agent 说明${preview ? ` · ${preview}` : ""}`;
}

/**
 * 功能：处理`thinking` 摘要。
 * 输入：`output`（string）提供输出。 `chinese`（boolean）提供chinese。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/agent-run-activity.ts:buildAgentRunActivity()` 调用；内部调用 `compactOneLine()`。
 */
function thinkingSummary(output: string, _chinese: boolean) {
  const preview = compactOneLine(output, 120);
  return `模型思考${preview ? ` · ${preview}` : ""}`;
}

/**
 * 功能：处理`system` 摘要。
 * 输入：`step`（string）提供step。 `status`（string）提供状态。 `chinese`（boolean）提供chinese。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/agent-run-activity.ts:buildAgentRunActivity()` 调用；内部调用 `startsWith()`、`displayAgentTraceStep()`。
 */
function systemSummary(step: string, status: string, _chinese: boolean) {
  if (step === "pi:agent_start") return "Agent 开始处理任务";
  if (step === "pi:agent_settled") return "Agent 已完成处理";
  if (step === "completed") return "任务完成";
  if (step === "failed" || step === "pi:failed") return "任务失败";
  if (step.startsWith("pi:compaction:")) return "正在压缩会话上下文";
  if (step.startsWith("pi:retry:")) return "正在重试模型请求";
  return `${displayAgentTraceStep(step)} · ${status}`;
}

/**
 * 功能：更新`detail`。
 * 输入：`detail`（MutableTraceDetail）提供detail。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/web/src/features/workspace/agent-run-activity.ts:buildAgentRunActivity()` 调用。
 */
function updateDetail(detail: MutableTraceDetail) {
  detail.detail = [
    detail.input ? `输入\n${detail.input}` : "",
    detail.output ? `输出\n${detail.output}` : "",
    detail.error ? `错误\n${detail.error}` : "",
  ].filter(Boolean).join("\n\n---\n\n");
}

/**
 * 功能：处理`trace` `id`。
 * 输入：`run`（RunSnapshot）提供运行。 `trace`（RunTrace）提供trace。 `index`（number）提供index。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/features/workspace/agent-run-activity.ts:buildAgentRunActivity()` 调用。
 */
function traceId(run: RunSnapshot, trace: RunTrace, index: number) {
  return `trace-${trace.id || `${run.id || "run"}-${index}`}`;
}

/**
 * 功能：判断是否为`final` 助手消息 输出。
 * 输入：`output`（string）提供输出。 `fallbackOutput`（string）提供fallback 输出。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/web/src/features/workspace/agent-run-activity.ts:buildAgentRunActivity()` 调用；内部调用 `replace()`、`endsWith()`。
 */
function isFinalAssistantOutput(output: string, fallbackOutput: string) {
  const normalizedOutput = output.replace(/\n\[truncated\]$/, "").trim();
  const normalizedFallback = fallbackOutput.trim();
  return Boolean(normalizedOutput)
    && Boolean(normalizedFallback)
    && (normalizedFallback === normalizedOutput || normalizedFallback.endsWith(normalizedOutput));
}

/**
 * 功能：构建Agent 运行 活动记录。
 * 输入：`run`（RunSnapshot）提供运行。 `fallbackOutput`（string）提供fallback 输出。
 * 输出：返回 AgentRunTraceDetail[]，供调用方继续处理。
 * 调用关系：由 `apps/web/src/features/workspace/WorkspacePage.tsx:toggleChatActivity()`、`apps/web/src/features/workspace/agent-run-activity.test.ts 顶层流程`、`apps/web/src/features/workspace/workspace-utils.ts:assistantEntryForRun()` 调用；内部调用 `prefersChinese()`、`isArray()`、`entries()`、`toolNameFromTraceStep()`、`isFinalAssistantOutput()`、`traceId()`。
 */
export function buildAgentRunActivity(
  run: RunSnapshot,
  fallbackOutput: string,
): AgentRunTraceDetail[] {
  const chinese = prefersChinese(run.prompt || fallbackOutput);
  const traces = Array.isArray(run.traceEvents) ? run.traceEvents : [];
  let finalAssistantTraceIndex = -1;
  for (let index = traces.length - 1; index >= 0; index -= 1) {
    if (traces[index]?.stepName === "pi:assistant_message") {
      finalAssistantTraceIndex = index;
      break;
    }
  }
  const details: MutableTraceDetail[] = [];
  const pendingTools = new Map<string, MutableTraceDetail[]>();

  for (const [index, trace] of traces.entries()) {
    const stepName = typeof trace.stepName === "string" ? trace.stepName : "";
    const status = typeof trace.stepStatus === "string" ? trace.stepStatus : "running";
    const input = trace.inputSummaryMarkdown?.trim() || "";
    const output = trace.outputSummaryMarkdown?.trim() || "";
    const error = trace.errorMarkdown?.trim() || "";
    const name = toolNameFromTraceStep(stepName);

    if (stepName === "pi:assistant_message" || stepName === "pi:assistant_thinking") {
      if (!output && !error) continue;
      const thinking = stepName === "pi:assistant_thinking";
      if (
        !thinking
        && index === finalAssistantTraceIndex
        && isFinalAssistantOutput(output, fallbackOutput)
      ) continue;
      const detail: MutableTraceDetail = {
        id: traceId(run, trace, index),
        stepName,
        status,
        summary: thinking
          ? thinkingSummary(output || error, chinese)
          : assistantSummary(output || error, chinese),
        detail: output || error,
        kind: thinking ? "thinking" : "assistant",
        input: "",
        output,
        error,
      };
      updateDetail(detail);
      details.push(detail);
      continue;
    }

    if (name) {
      const callId = toolCallId(trace);
      if (status === "running") {
        const detail: MutableTraceDetail = {
          id: traceId(run, trace, index),
          stepName,
          status,
          summary: "",
          detail: "",
          kind: "tool",
          input,
          output,
          error,
          toolCallId: callId,
        };
        detail.summary = toolSummary(detail, chinese);
        updateDetail(detail);
        details.push(detail);
        const queue = pendingTools.get(stepName) || [];
        queue.push(detail);
        pendingTools.set(stepName, queue);
        continue;
      }

      const queue = pendingTools.get(stepName) || [];
      const matchingIndex = callId
        ? queue.findIndex((detail) => detail.toolCallId === callId)
        : 0;
      const detail = matchingIndex >= 0 ? queue.splice(matchingIndex, 1)[0] : undefined;
      if (detail) {
        detail.status = status;
        detail.output = output;
        detail.error = error;
        detail.summary = toolSummary(detail, chinese);
        updateDetail(detail);
      } else {
        const terminalDetail: MutableTraceDetail = {
          id: traceId(run, trace, index),
          stepName,
          status,
          summary: "",
          detail: "",
          kind: "tool",
          input,
          output,
          error,
          toolCallId: callId,
        };
        terminalDetail.summary = toolSummary(terminalDetail, chinese);
        updateDetail(terminalDetail);
        details.push(terminalDetail);
      }
      continue;
    }

    const isProcessEvent = stepName === "pi:agent_start"
      || stepName === "pi:agent_settled"
      || stepName.startsWith("pi:compaction:")
      || stepName.startsWith("pi:retry:")
      || ["completed", "failed", "tool_error", "session.compacted", "pi:failed"].includes(stepName);
    if (!isProcessEvent) continue;
    const detail: MutableTraceDetail = {
      id: traceId(run, trace, index),
      stepName,
      status,
      summary: systemSummary(stepName, status, chinese),
      detail: "",
      kind: "system",
      input,
      output,
      error,
    };
    updateDetail(detail);
    details.push(detail);
  }

  return details.map((detail) => ({
    id: detail.id,
    stepName: detail.stepName,
    status: detail.status,
    summary: detail.summary,
    detail: detail.detail,
    kind: detail.kind,
  }));
}
