/**
 * 文件作用：实现后端“Coding Agent 与 Pi 适配”业务模块中的 `truncate`、`truncateResponse`、`contentText` 等能力。
 * 模块位置：`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts`，属于后端“Coding Agent 与 Pi 适配”业务模块。
 * 重要函数：`truncate()` 负责处理`truncate`；`truncateResponse()` 负责处理`truncate` 响应；`contentText()` 负责处理`content` `text`；`contentThinking()` 负责处理`content` `thinking`；`encodeResponse()` 负责处理`encode` 响应；`safeJson()` 负责处理`safe` `json`。
 */
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import { logSystem } from "../../../../infrastructure/logging/logger.js";
import type { AgentRunStore } from "../../../agent-runs/index.js";

const RESPONSE_FLUSH_INTERVAL_MS = 250;
const MAX_RESPONSE_CHARS = 18_000;
const MAX_TRACE_CHARS = 12_000;
const THINKING_START = "<!-- courseworks-thinking:start -->";
const THINKING_END = "<!-- courseworks-thinking:end -->";

/**
 * 功能：处理`truncate`。
 * 输入：`value`（string）提供value。 `max`提供max。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:safeJson()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:buildFallbackAnswer()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:persist()`、`apps/server/src/modules/conversations/session-store.ts:deriveSessionTitle()`、`apps/server/src/modules/conversations/session-store.ts:createSessionEntry()` 调用。
 */
function truncate(value: string, max = MAX_TRACE_CHARS) {
  return value.length > max ? `${value.slice(0, max)}\n[truncated]` : value;
}

/**
 * 功能：处理`truncate` 响应。
 * 输入：`value`（string）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:encodeResponse()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:buildFallbackAnswer()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:buildResponseMarkdown()` 调用；内部调用 `floor()`。
 */
function truncateResponse(value: string) {
  if (value.length <= MAX_RESPONSE_CHARS) return value;
  const half = Math.floor(MAX_RESPONSE_CHARS / 2);
  return `${value.slice(0, half)}\n\n[earlier response truncated]\n\n${value.slice(-half)}`;
}

/**
 * 功能：处理`content` `text`。
 * 输入：`content`（unknown）提供content。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.test.ts 顶层流程`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:bind()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:persist()` 调用；内部调用 `isArray()`。
 */
function contentText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

/**
 * 功能：处理`content` `thinking`。
 * 输入：`content`（unknown）提供content。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:bind()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:persist()` 调用；内部调用 `isArray()`。
 */
function contentThinking(content: unknown) {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "thinking"; thinking: string } =>
        typeof part === "object"
        && part !== null
        && (part as { type?: unknown }).type === "thinking"
        && typeof (part as { thinking?: unknown }).thinking === "string",
    )
    .map((part) => part.thinking)
    .join("");
}

/**
 * 功能：处理`encode` 响应。
 * 输入：`thinking`（string）提供thinking。 `text`（string）提供text。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:buildResponseMarkdown()` 调用；内部调用 `truncateResponse()`。
 */
function encodeResponse(thinking: string, text: string) {
  const sections: string[] = [];
  if (thinking.trim()) {
    sections.push(
      THINKING_START,
      truncateResponse(thinking),
      THINKING_END,
    );
  }
  if (text.trim()) sections.push(text);
  return sections.join("\n\n");
}

/**
 * 功能：处理`safe` `json`。
 * 输入：`value`（unknown）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:persist()` 调用；内部调用 `truncate()`、`stringify()`。
 */
function safeJson(value: unknown) {
  try {
    return truncate(JSON.stringify(value));
  } catch {
    return "[unserializable]";
  }
}

export class PiRunEventSink {
  private queue = Promise.resolve();
  private readonly assistantMessages: string[] = [];
  private readonly assistantThinkingMessages: string[] = [];
  private currentAssistantText = "";
  private currentAssistantThinking = "";
  private pendingResponseMarkdown: string | undefined;
  private responseFlushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastToolResult:
    | { toolName: string; text: string; isError: boolean }
    | undefined;

  /**
   * 功能：初始化 Pi 流事件接收器及运行记录依赖。
   * 输入：`runId`（string）提供运行 id。 `store`（AgentRunStore）提供store。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由创建该类实例的代码自动调用。
   */
  constructor(
    private readonly runId: string,
    private readonly store: AgentRunStore,
    private readonly onTokenUsage?: (tokens: number) => Promise<void>,
  ) {}

  /**
   * 功能：处理`bind`。
   * 输入：`session`（AgentSession）提供会话。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()` 调用；内部调用 `subscribe()`、`contentText()`、`contentThinking()`、`queueResponseUpdate()`、`enqueue()`、`persist()`。
   */
  bind(session: AgentSession) {
    return session.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant") {
        this.currentAssistantText = "";
        this.currentAssistantThinking = "";
        return;
      } else if (
        event.type === "message_update"
        && event.message.role === "assistant"
        && "partial" in event.assistantMessageEvent
      ) {
        const text = contentText(event.assistantMessageEvent.partial.content);
        const thinking = contentThinking(event.assistantMessageEvent.partial.content);
        if (text !== this.currentAssistantText || thinking !== this.currentAssistantThinking) {
          this.currentAssistantText = text;
          this.currentAssistantThinking = thinking;
          this.queueResponseUpdate();
        }
        return;
      }
      this.enqueue(() => this.persist(event));
    });
  }

  /**
   * 功能：立即写出`flush` 对应的数据。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:createPiSession()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()` 调用；内部调用 `clearResponseFlushTimer()`、`enqueue()`、`flushPendingResponse()`。
   */
  async flush() {
    this.clearResponseFlushTimer();
    this.enqueue(() => this.flushPendingResponse());
    await this.queue;
  }

  /**
   * 功能：构建`fallback` `answer`。
   * 输入：`chinese`（boolean）提供chinese。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()` 调用；内部调用 `find()`、`reverse()`、`truncate()`、`truncateResponse()`。
   */
  buildFallbackAnswer(chinese: boolean) {
    const lastAssistantText = this.assistantMessages
      .slice()
      .reverse()
      .find((text) => text.trim());
    const sections = chinese
      ? [
          "## 任务执行结束",
          "",
          "Pi Agent 已完成最后一次工具执行，但模型没有返回单独的最终总结。",
        ]
      : [
          "## Task Finished",
          "",
          "Pi Agent completed the last tool call, but the model did not return a separate final summary.",
        ];
    if (lastAssistantText) {
      sections.push(
        "",
        chinese ? "### 模型最后说明" : "### Last Model Message",
        "",
        truncate(lastAssistantText),
      );
    }
    if (this.lastToolResult) {
      sections.push(
        "",
        chinese
          ? `### 最后工具结果：${this.lastToolResult.toolName}`
          : `### Last Tool Result: ${this.lastToolResult.toolName}`,
        "",
        this.lastToolResult.isError
          ? (chinese ? "工具执行失败。" : "The tool call failed.")
          : (chinese ? "工具执行成功。" : "The tool call succeeded."),
      );
      if (this.lastToolResult.text.trim()) {
        sections.push("", "```text", truncate(this.lastToolResult.text), "```");
      }
    }
    if (!lastAssistantText && !this.lastToolResult) {
      sections.push("", chinese ? "没有可用的模型文本或工具结果。" : "No model text or tool result was available.");
    }
    return truncateResponse(sections.join("\n"));
  }

  /**
   * 功能：判断是否包含`execution` `evidence`。
   * 输入：无显式输入参数。
   * 输出：返回判断或校验结果；校验失败时可能抛出异常。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()` 调用；内部调用 `some()`。
   */
  hasExecutionEvidence() {
    return this.assistantMessages.some((text) => text.trim()) || Boolean(this.lastToolResult);
  }

  /**
   * 功能：构建响应 Markdown 内容。
   * 输入：`finalAnswer`（string）提供final answer。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:responseMarkdown()` 调用；内部调用 `encodeResponse()`、`truncateResponse()`。
   */
  buildResponseMarkdown(finalAnswer?: string) {
    const thinking = [...this.assistantThinkingMessages, this.currentAssistantThinking]
      .filter((text) => text.trim())
      .join("\n\n");
    const text = finalAnswer ?? [...this.assistantMessages, this.currentAssistantText]
      .filter((value) => value.trim())
      .join("\n\n");
    return encodeResponse(thinking, truncateResponse(text));
  }

  /**
   * 功能：处理`enqueue`。
   * 输入：`operation`（() => Promise<void>）提供operation。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:bind()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:flush()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:queueResponseUpdate()` 调用；内部调用 `catch()`、`then()`、`logSystem()`。
   */
  private enqueue(operation: () => Promise<void>) {
    this.queue = this.queue
      .then(operation)
      .catch((error: unknown) => {
        logSystem(
          `[${this.runId.slice(0, 8)}] failed to persist Pi event: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  /**
   * 功能：处理响应 Markdown 内容。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:queueResponseUpdate()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:persist()` 调用；内部调用 `buildResponseMarkdown()`。
   */
  private responseMarkdown() {
    return this.buildResponseMarkdown();
  }

  /**
   * 功能：处理`queue` 响应 `update`。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:bind()` 调用；内部调用 `responseMarkdown()`、`setTimeout()`、`enqueue()`、`flushPendingResponse()`。
   */
  private queueResponseUpdate() {
    const responseMarkdown = this.responseMarkdown();
    if (!responseMarkdown.trim()) return;
    this.pendingResponseMarkdown = responseMarkdown;
    if (this.responseFlushTimer) return;
    this.responseFlushTimer = setTimeout(() => {
      this.responseFlushTimer = undefined;
      this.enqueue(() => this.flushPendingResponse());
    }, RESPONSE_FLUSH_INTERVAL_MS);
  }

  /**
   * 功能：清理响应 `flush` `timer`。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:flush()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:persist()` 调用；内部调用 `clearTimeout()`。
   */
  private clearResponseFlushTimer() {
    if (!this.responseFlushTimer) return;
    clearTimeout(this.responseFlushTimer);
    this.responseFlushTimer = undefined;
  }

  /**
   * 功能：立即写出`pending` 响应。
   * 输入：无显式输入参数。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:flush()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:queueResponseUpdate()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:persist()` 调用；内部调用 `updateResponse()`。
   */
  private async flushPendingResponse() {
    const responseMarkdown = this.pendingResponseMarkdown;
    this.pendingResponseMarkdown = undefined;
    if (responseMarkdown?.trim()) {
      await this.store.updateResponse(this.runId, responseMarkdown);
    }
  }

  /**
   * 功能：处理`persist`。
   * 输入：`event`（AgentSessionEvent）提供event。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:bind()` 调用；内部调用 `updateStatus()`、`appendTrace()`、`contentText()`、`contentThinking()`、`at()`、`responseMarkdown()`。
   */
  private async persist(event: AgentSessionEvent) {
    switch (event.type) {
      case "agent_start":
        await this.store.updateStatus(this.runId, "planning", "pi:agent_start");
        await this.store.appendTrace(this.runId, {
          stepName: "pi:agent_start",
          stepStatus: "running",
        });
        return;
      case "message_end": {
        if (event.message.role !== "assistant") return;
        await this.onTokenUsage?.(
          Math.max(0, event.message.usage.input) + Math.max(0, event.message.usage.output),
        );
        const text = contentText(event.message.content);
        const thinking = contentThinking(event.message.content);
        if (thinking.trim() && this.assistantThinkingMessages.at(-1) !== thinking) {
          this.assistantThinkingMessages.push(thinking);
        }
        if (text.trim() && this.assistantMessages.at(-1) !== text) {
          this.assistantMessages.push(text);
        }
        this.currentAssistantText = "";
        this.currentAssistantThinking = "";
        this.pendingResponseMarkdown = this.responseMarkdown();
        this.clearResponseFlushTimer();
        await this.flushPendingResponse();
        const failed = event.message.stopReason === "error"
          || event.message.stopReason === "length"
          || event.message.stopReason === "aborted";
        if (thinking.trim()) {
          await this.store.appendTrace(this.runId, {
            stepName: "pi:assistant_thinking",
            stepStatus: failed ? "failed" : "success",
            outputSummaryMarkdown: truncate(thinking),
            errorMarkdown: event.message.errorMessage,
          });
        }
        await this.store.appendTrace(this.runId, {
          stepName: "pi:assistant_message",
          stepStatus: failed ? "failed" : "success",
          outputSummaryMarkdown: truncate(text),
          errorMarkdown: event.message.errorMessage,
          debugMarkdown: safeJson({
            provider: event.message.provider,
            model: event.message.model,
            stopReason: event.message.stopReason,
            usage: event.message.usage,
          }),
        });
        return;
      }
      case "tool_execution_start":
        await this.store.updateStatus(this.runId, "patch_applying", `pi:tool:${event.toolName}`);
        await this.store.appendTrace(this.runId, {
          stepName: `pi:tool:${event.toolName}`,
          stepStatus: "running",
          inputSummaryMarkdown: `\`${safeJson(event.args)}\``,
          debugMarkdown: safeJson({ toolCallId: event.toolCallId }),
        });
        return;
      case "tool_execution_end":
        this.lastToolResult = {
          toolName: event.toolName,
          text: contentText(event.result?.content),
          isError: event.isError,
        };
        await this.store.appendTrace(this.runId, {
          stepName: `pi:tool:${event.toolName}`,
          stepStatus: event.isError ? "failed" : "success",
          outputSummaryMarkdown: truncate(contentText(event.result?.content)),
          errorMarkdown: event.isError ? truncate(contentText(event.result?.content)) : undefined,
          debugMarkdown: safeJson({ toolCallId: event.toolCallId }),
        });
        return;
      case "compaction_start":
        await this.store.appendTrace(this.runId, {
          stepName: `pi:compaction:${event.reason}`,
          stepStatus: "running",
        });
        return;
      case "compaction_end":
        if (event.result?.usage) {
          await this.onTokenUsage?.(
            Math.max(0, event.result.usage.input) + Math.max(0, event.result.usage.output),
          );
        }
        await this.store.appendTrace(this.runId, {
          stepName: `pi:compaction:${event.reason}`,
          stepStatus: event.errorMessage ? "failed" : "success",
          outputSummaryMarkdown: event.result
            ? `Context compacted from approximately ${event.result.tokensBefore} tokens.`
            : undefined,
          errorMarkdown: event.errorMessage,
        });
        return;
      case "auto_retry_start":
        await this.store.appendTrace(this.runId, {
          stepName: `pi:retry:${event.attempt}`,
          stepStatus: "running",
          errorMarkdown: event.errorMessage,
        });
        return;
      case "auto_retry_end":
        await this.store.appendTrace(this.runId, {
          stepName: `pi:retry:${event.attempt}`,
          stepStatus: event.success ? "success" : "failed",
          errorMarkdown: event.finalError,
        });
        return;
      case "agent_settled":
        await this.store.appendTrace(this.runId, {
          stepName: "pi:agent_settled",
          stepStatus: "success",
        });
        return;
      default:
        return;
    }
  }
}
