/**
 * 文件作用：实现后端基础设施层中的 `isLogViewerEnabled`、`initLogFile`、`callerLocation` 等能力。
 * 模块位置：`apps/server/src/infrastructure/logging/logger.ts`，属于后端基础设施层。
 * 重要函数：`isLogViewerEnabled()` 负责判断是否为日志 `viewer` `enabled`；`initLogFile()` 负责处理`init` 日志 文件；`callerLocation()` 负责处理`caller` `location`；`writeLogLine()` 负责写入日志 `line`；`logInput()` 负责处理日志 结构化输入；`logAutoReply()` 负责处理日志 `auto` `reply`；`logLlmRequest()` 负责处理日志 `llm` 请求；`logLlmResponse()` 负责处理日志 `llm` 响应。
 */
// 轻量调试日志 — 只在 LOG_VIEWER_ENABLED=true 时写文件
// 正式部署时关闭，不影响正常系统运行
//
// 日志格式：[时间] [email] [阶段] 消息内容
// 阶段：input | auto-reply | llm-request | llm-response | http | system

import fs from "node:fs";
import path from "node:path";

const MAX_BUFFER_LINES = 50000;
const ringBuffer: string[] = [];

let logFile: string | null = null;
let writeStream: fs.WriteStream | null = null;

/**
 * 功能：判断是否为日志 `viewer` `enabled`。
 * 输入：无显式输入参数。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/app/app.ts 顶层流程`、`apps/server/src/app/server.ts 顶层流程`、`apps/server/src/infrastructure/logging/logger.ts:initLogFile()`、`apps/server/src/infrastructure/logging/logger.ts:logInput()`、`apps/server/src/infrastructure/logging/logger.ts:logAutoReply()` 调用。
 */
export function isLogViewerEnabled() {
  return process.env.LOG_VIEWER_ENABLED === "true";
}

/**
 * 功能：处理`init` 日志 文件。
 * 输入：`workspaceRoot`（string）提供工作区 根目录。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/app/server.ts 顶层流程` 调用；内部调用 `isLogViewerEnabled()`、`dirname()`、`mkdirSync()`、`createWriteStream()`、`writeLogLine()`。
 */
export function initLogFile(workspaceRoot: string) {
  if (!isLogViewerEnabled()) return;
  logFile = path.join(workspaceRoot, "..", "logs", "debug.log");
  const dir = path.dirname(logFile);
  fs.mkdirSync(dir, { recursive: true });
  writeStream = fs.createWriteStream(logFile, { flags: "a" });
  writeLogLine("—", "system", "Log viewer initialized — port 9090");
}

/**
 * 功能：处理`caller` `location`。
 * 输入：无显式输入参数。
 * 输出：返回 string，供调用方继续处理。
 * 调用关系：由 `apps/server/src/infrastructure/logging/logger.ts:writeLogLine()` 调用；内部调用 `split()`、`match()`、`includes()`、`replace()`。
 */
function callerLocation(): string {
  const stack = new Error().stack;
  if (!stack) return "?";
  // 跳过 Error、callerLocation、writeLogLine、各 log* 函数的栈帧
  const lines = stack.split("\n");
  for (let i = 4; i < lines.length; i++) {
    const match = lines[i].match(/\(?(.+?):(\d+):(\d+)\)?$/);
    if (match && !match[1].includes("node:internal") && !match[1].includes("logger.")) {
      let file = match[1];
      // 去掉绝对路径前缀，只保留项目内相对路径
      file = file.replace(/^.*\/courseworks\//, "");
      return `${file}:${match[2]}`;
    }
  }
  return "?";
}

/**
 * 功能：写入日志 `line`。
 * 输入：`email`（string）提供email。 `stage`（string）提供stage。 `message`（string）提供消息。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/infrastructure/logging/logger.ts:initLogFile()`、`apps/server/src/infrastructure/logging/logger.ts:logInput()`、`apps/server/src/infrastructure/logging/logger.ts:logAutoReply()`、`apps/server/src/infrastructure/logging/logger.ts:logLlmRequest()`、`apps/server/src/infrastructure/logging/logger.ts:logLlmResponse()` 调用；内部调用 `replace()`、`toISOString()`、`callerLocation()`、`shift()`、`write()`。
 */
function writeLogLine(email: string, stage: string, message: string) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 23);
  const emailPart = email.length > 30 ? `${email.slice(0, 27)}...` : email;
  const loc = callerLocation();
  const line = `${ts}\t${emailPart}\t${stage}\t${loc}\t${message}`;
  ringBuffer.push(line);
  if (ringBuffer.length > MAX_BUFFER_LINES) ringBuffer.shift();

  if (writeStream) {
    writeStream.write(line + "\n");
  }
}

// ---- 对外 API ----

/** 用户输入 */
/**
 * 功能：处理日志 结构化输入。
 * 输入：`email`（string）提供email。 `prompt`（string）提供提示词。 `openFiles`提供open 文件列表。 `attachments`提供attachments。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:submitAgentPrompt()`、`apps/server/src/application/agent/agent-application.service.ts:startNewAgentChat()`、`apps/server/src/application/agent/agent-application.service.ts:compactAgentChat()` 调用；内部调用 `isLogViewerEnabled()`、`writeLogLine()`。
 */
export function logInput(email: string, prompt: string, openFiles = 0, attachments = 0) {
  if (!isLogViewerEnabled()) return;
  const extra: string[] = [];
  if (openFiles > 0) extra.push(`files:${openFiles}`);
  if (attachments > 0) extra.push(`attach:${attachments}`);
  const suffix = extra.length ? ` (${extra.join(" ")})` : "";
  writeLogLine(email, "input", `"${prompt}"${suffix}`);
}

/** auto-reply 模块处理结果 */
/**
 * 功能：处理日志 `auto` `reply`。
 * 输入：`email`（string）提供email。 `action`（string）提供action。 `detail`提供detail。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:submitAgentPrompt()`、`apps/server/src/application/agent/agent-application.service.ts:startNewAgentChat()`、`apps/server/src/application/agent/agent-application.service.ts:compactAgentChat()` 调用；内部调用 `isLogViewerEnabled()`、`writeLogLine()`。
 */
export function logAutoReply(email: string, action: string, detail = "") {
  if (!isLogViewerEnabled()) return;
  writeLogLine(email, "auto-reply", `${action}${detail ? ` → ${detail}` : ""}`);
}

/** 发给 LLM 的请求 */
/**
 * 功能：处理日志 `llm` 请求。
 * 输入：`email`（string）提供email。 `model`（string）提供模型。 `msgCount`（number）提供msg count。 `totalChars`（number）提供total chars。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `isLogViewerEnabled()`、`writeLogLine()`、`ceil()`。
 */
export function logLlmRequest(email: string, model: string, msgCount: number, totalChars: number) {
  if (!isLogViewerEnabled()) return;
  writeLogLine(
    email, "llm-request",
    `model=${model} msgs=${msgCount} chars=${totalChars} (~${Math.ceil(totalChars / 4)} tokens)`
  );
}

/** LLM 返回的响应 */
/**
 * 功能：处理日志 `llm` 响应。
 * 输入：`email`（string）提供email。 `success`（boolean）提供success。 `content`（string）提供content。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()` 调用；内部调用 `isLogViewerEnabled()`、`writeLogLine()`。
 */
export function logLlmResponse(email: string, success: boolean, content: string) {
  if (!isLogViewerEnabled()) return;
  const status = success ? "✓" : "✗";
  writeLogLine(email, "llm-response", `${status} "${content}"`);
}

/** HTTP 请求日志 */
/**
 * 功能：处理日志 `http`。
 * 输入：`email`（string）提供email。 `method`（string）提供method。 `url`（string）提供url。 `statusCode`（number）提供状态 代码。 `ms`（number）提供ms。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/app/app.ts 顶层流程` 调用；内部调用 `isLogViewerEnabled()`、`startsWith()`、`test()`、`writeLogLine()`。
 */
export function logHttp(email: string, method: string, url: string, statusCode: number, ms: number) {
  if (!isLogViewerEnabled()) return;
  // 屏蔽日志查看器自身轮询
  if (url.startsWith("/api/logs")) return;
  // 屏蔽前端轮询请求（keep-alive、tree 刷新、run 状态轮询、lab 状态）
  if (url.startsWith("/api/workspace/tree")) return;
  if (url.startsWith("/api/workspace/lab")) return;
  if (/\/api\/agent\/runs\/[^/]+$/.test(url) && method === "GET") return;
  const emoji = statusCode >= 400 ? "❌" : statusCode >= 300 ? "↪" : "✓";
  writeLogLine(email, "http", `${emoji} ${method} ${url} → ${statusCode} (${ms}ms)`);
}

/** 系统级事件 */
/**
 * 功能：处理日志 `system`。
 * 输入：`message`（string）提供消息。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/app/server.ts 顶层流程`、`apps/server/src/application/agent/agent-application.service.ts:refreshEvaluationHistorySafely()`、`apps/server/src/application/agent/agent-application.service.ts:submitAgentPrompt()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:enqueue()` 调用；内部调用 `isLogViewerEnabled()`、`writeLogLine()`。
 */
export function logSystem(message: string) {
  if (!isLogViewerEnabled()) return;
  writeLogLine("—", "system", message);
}

/**
 * 功能：获取`recent` 日志列表。
 * 输入：`lines`提供lines。
 * 输出：返回 string[]，供调用方继续处理。
 * 调用关系：由 `apps/server/src/transport/http/routes/logs.router.ts 顶层流程` 调用。
 */
export function getRecentLogs(lines = 200): string[] {
  return ringBuffer.slice(-lines);
}
