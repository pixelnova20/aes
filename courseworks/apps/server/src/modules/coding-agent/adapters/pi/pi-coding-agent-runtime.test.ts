/**
 * 文件作用：验证后端“Coding Agent 与 Pi 适配”业务模块中的关键行为和回归场景。
 * 模块位置：`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.test.ts`，属于后端“Coding Agent 与 Pi 适配”业务模块。
 * 重要函数：`startMockProvider()` 负责启动`mock` Provider；`startSingleResponseProvider()` 负责启动`single` 响应 Provider；`startThinkingResponseProvider()` 负责启动`thinking` 响应 Provider；`startStalledProvider()` 负责启动`stalled` Provider；`startCompactionFailureProvider()` 负责启动`compaction` `failure` Provider；`startModelSwitchSuccessProvider()` 负责启动模型 `switch` `success` Provider；`contentText()` 负责处理`content` `text`。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import type { AgentRunStatus } from "@prisma/client";

import type {
  AgentRunStore,
  AgentTraceInput,
} from "../../../agent-runs/index.js";
import {
  buildRuntimeAiIdentityPrompt,
  PiCodingAgentRuntime,
  sanitizeOutboundContext,
} from "./pi-coding-agent-runtime.js";
import {
  getPiSessionModelConfiguration,
  openPiSession,
  readPiSessionHistory,
} from "./pi-session-store.js";
import type { StudentSession } from "../../../conversations/index.js";

type CapturedRequest = {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown; [key: string]: unknown }>;
  temperature?: number;
  thinking?: { type?: string };
  reasoning_effort?: string;
};

test("Pi runtime identity prompt exposes selected model metadata without secrets", () => {
  const prompt = buildRuntimeAiIdentityPrompt({
    apiKey: "super-secret-key",
    baseUrl: "https://internal.example/v1",
    model: "DeepSeek-V4-Pro",
    profileName: "课程模型",
    profileSource: "class",
    reasoningEffort: "high",
  });

  assert.match(prompt, /DeepSeek-V4-Pro/);
  assert.match(prompt, /课程模型/);
  assert.match(prompt, /班级强制配置/);
  assert.match(prompt, /high/);
  assert.doesNotMatch(prompt, /super-secret-key/);
  assert.doesNotMatch(prompt, /internal\.example/);
});

class FakeAgentRunStore implements AgentRunStore {
  readonly completed: Array<{ runId: string; answer: string }> = [];
  readonly failed: Array<{ runId: string; message: string }> = [];
  readonly responses: Array<{ runId: string; markdown: string }> = [];
  readonly traces: Array<{ runId: string; trace: AgentTraceInput }> = [];

  /**
   * 功能：更新状态。
   * 输入：`_runId`（string）提供运行 id。 `_status`（AgentRunStatus）提供状态。 `_currentStep`（string）提供current step。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:persist()` 调用。
   */
  async updateStatus(_runId: string, _status: AgentRunStatus, _currentStep: string) {}

  /**
   * 功能：更新响应。
   * 输入：`runId`（string）提供运行 id。 `responseMarkdown`（string）提供响应 Markdown 内容。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:flushPendingResponse()` 调用。
   */
  async updateResponse(runId: string, responseMarkdown: string) {
    this.responses.push({ runId, markdown: responseMarkdown });
  }

  /**
   * 功能：追加`trace`。
   * 输入：`runId`（string）提供运行 id。 `trace`（AgentTraceInput）提供trace。
   * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:prepareModelConfiguration()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-run-event-sink.ts:persist()` 调用。
   */
  async appendTrace(runId: string, trace: AgentTraceInput) {
    this.traces.push({ runId, trace });
  }

  /**
   * 功能：处理`complete`。
   * 输入：`runId`（string）提供运行 id。 `finalAnswer`（string）提供final answer。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()` 调用。
   */
  async complete(runId: string, finalAnswer: string) {
    this.completed.push({ runId, answer: finalAnswer });
  }

  /**
   * 功能：处理`fail`。
   * 输入：`runId`（string）提供运行 id。 `message`（string）提供消息。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/ai-settings/local-model-catalog.service.test.ts 顶层流程`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()`、`scripts/check-dependencies.mjs:checkArchitectureBoundaries()`、`scripts/check-dependencies.mjs:visitModule()`、`scripts/check-dependencies.mjs 顶层流程` 调用。
   */
  async fail(runId: string, message: string) {
    this.failed.push({ runId, message });
  }

  /**
   * 功能：处理`cancel`。
   * 输入：`_runId`（string）提供运行 id。 `_finalAnswer`（string）提供final answer。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:run()` 调用。
   */
  async cancel(_runId: string, _finalAnswer?: string) {}
}

/**
 * 功能：启动`mock` Provider。
 * 输入：`requests`（CapturedRequest[]）提供requests。 `options`（{ emptyFinalAfterTool?: boolean }）提供options。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.test.ts 顶层流程` 调用；内部调用 `createServer()`、`setEncoding()`、`on()`、`parse()`、`writeHead()`、`write()`。
 */
function startMockProvider(
  requests: CapturedRequest[],
  options: { emptyFinalAfterTool?: boolean; thinkingOnFirstResponse?: string } = {},
) {
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(JSON.parse(body) as CapturedRequest);
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (requests.length === 1) {
        if (options.thinkingOnFirstResponse) {
          response.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-tool",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "mock-model",
              choices: [{
                index: 0,
                delta: {
                  role: "assistant",
                  reasoning_content: options.thinkingOnFirstResponse,
                },
                finish_reason: null,
              }],
            })}\n\n`,
          );
        }
        if (options.emptyFinalAfterTool) {
          response.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-tool",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "mock-model",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "正在检查并修改文件。" },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
        }
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-tool",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "mock-model",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-write",
                      type: "function",
                      function: {
                        name: "write",
                        arguments: JSON.stringify({
                          path: "test/from-agent.txt",
                          content: "written-by-pi\n",
                        }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
      } else {
        const answer = requests.length === 2 ? "first-answer" : "second-answer";
        if (!options.emptyFinalAfterTool) {
          response.write(
            `data: ${JSON.stringify({
              id: `chatcmpl-${requests.length}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "mock-model",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: answer },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
        }
      }
      response.write(
        `data: ${JSON.stringify({
          id: `chatcmpl-${requests.length}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "mock-model",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: requests.length === 1 ? "tool_calls" : "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            total_tokens: 12,
          },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
      });
    });
  });
}

/**
 * 功能：启动`single` 响应 Provider。
 * 输入：`input`（{ content?: string; finishReason: "stop" | "length"; }）提供当前操作所需的结构化输入。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.test.ts 顶层流程` 调用；内部调用 `createServer()`、`resume()`、`on()`、`writeHead()`、`write()`、`stringify()`。
 */
function startSingleResponseProvider(input: {
  content?: string;
  finishReason: "stop" | "length";
  requests?: string[];
}) {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      input.requests?.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      if (input.content !== undefined) {
        response.write(`data: ${JSON.stringify({
          id: "chatcmpl-single",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "mock-model",
          choices: [{
            index: 0,
            delta: { role: "assistant", content: input.content },
            finish_reason: null,
          }],
        })}\n\n`);
      }
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-single",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "mock-model",
        choices: [{ index: 0, delta: {}, finish_reason: input.finishReason }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/v1` });
    });
  });
}

/**
 * 功能：启动`thinking` 响应 Provider。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.test.ts 顶层流程` 调用；内部调用 `createServer()`、`resume()`、`on()`、`writeHead()`、`write()`、`stringify()`。
 */
function startThinkingResponseProvider() {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-thinking",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "DeepSeek-V4-Pro",
        choices: [{
          index: 0,
          delta: { role: "assistant", reasoning_content: "先检查工程，再执行修改。" },
          finish_reason: null,
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-thinking",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "DeepSeek-V4-Pro",
        choices: [{
          index: 0,
          delta: { content: "任务已经完成。" },
          finish_reason: null,
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "chatcmpl-thinking",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "DeepSeek-V4-Pro",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/v1` });
    });
  });
}

/**
 * 功能：启动`stalled` Provider。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.test.ts 顶层流程` 调用；内部调用 `createServer()`、`resume()`、`on()`、`writeHead()`、`listen()`、`address()`。
 */
function startStalledProvider() {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
    });
  });
  return new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/v1` });
    });
  });
}

/**
 * 功能：启动`compaction` `failure` Provider。
 * 输入：`requests`（CapturedRequest[]）提供requests。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.test.ts 顶层流程` 调用；内部调用 `createServer()`、`setEncoding()`、`on()`、`parse()`、`writeHead()`、`end()`。
 */
function startCompactionFailureProvider(requests: CapturedRequest[]) {
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const captured = JSON.parse(body) as CapturedRequest;
      requests.push(captured);
      if (requests.length > 3) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "mock compaction failure" } }));
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write(`data: ${JSON.stringify({
        id: `chatcmpl-history-${requests.length}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: captured.model ?? "DeepSeek-V4-Pro",
        choices: [{
          index: 0,
          delta: { role: "assistant", content: `history-answer-${requests.length}` },
          finish_reason: null,
        }],
      })}\n\n`);
      const promptTokens = requests.length === 3 ? 14_000 : 100;
      response.write(`data: ${JSON.stringify({
        id: `chatcmpl-history-${requests.length}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "model-a",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: 10,
          total_tokens: promptTokens + 10,
        },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/v1` });
    });
  });
}

/**
 * 功能：启动模型 `switch` `success` Provider。
 * 输入：`requests`（CapturedRequest[]）提供requests。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.test.ts 顶层流程` 调用；内部调用 `createServer()`、`setEncoding()`、`on()`、`parse()`、`writeHead()`、`write()`。
 */
function startModelSwitchSuccessProvider(requests: CapturedRequest[]) {
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const captured = JSON.parse(body) as CapturedRequest;
      requests.push(captured);
      const model = captured.model ?? "unknown-model";
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      response.write(`data: ${JSON.stringify({
        id: `chatcmpl-switch-${requests.length}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta: { role: "assistant", content: `${model}-answer` },
          finish_reason: null,
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: `chatcmpl-switch-${requests.length}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  return new Promise<{ server: http.Server; baseUrl: string }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/v1` });
    });
  });
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
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("Pi runtime restores the first turn when sending the second prompt", async (context) => {
  const requests: CapturedRequest[] = [];
  const provider = await startMockProvider(requests, {
    thinkingOnFirstResponse: "internal reasoning must not be replayed",
  });
  context.after(() => provider.server.close());

  const workspacePath = path.join(
    process.env.WORKSPACE_ROOT!,
    "pi-runtime",
    "workspace",
  );
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const now = new Date().toISOString();
  const chatSession: StudentSession = {
    sessionId: "22222222-2222-4222-8222-222222222222",
    sessionKey: "course:test:user:test",
    title: "Pi test",
    createdAt: now,
    updatedAt: now,
    turnCount: 0,
    status: "active",
  };
  const store = new FakeAgentRunStore();
  const runtime = new PiCodingAgentRuntime(store);
  const common = {
    userId: "user-test",
    workspacePath,
    cwd: workspacePath,
    aiSettings: {
      apiKey: "test-key",
      baseUrl: provider.baseUrl,
      model: "mock-model",
      contextWindowTokens: 16_384,
      temperature: 0.25,
    },
    chatSession,
  };

  const first = await runtime.run({
    ...common,
    runId: "run-first",
    prompt: "first-prompt",
  });
  const second = await runtime.run({
    ...common,
    runId: "run-second",
    prompt: "second-prompt",
  });

  assert.equal(first, "first-answer");
  assert.equal(second, "second-answer");
  assert.equal(store.failed.length, 0);
  assert.equal(store.completed.length, 2);
  assert.ok(
    store.responses.some(({ markdown }) => markdown.includes("first-answer")),
    "Pi assistant text must be persisted while the run is active.",
  );
  assert.equal(requests.length, 3);
  assert.equal(requests[0].temperature, 0.25);
  const firstSystemPrompt = (requests[0].messages ?? [])
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => contentText(message.content))
    .join("\n");
  assert.match(firstSystemPrompt, /Current working directory: \/home\/runner\/project/);
  assert.doesNotMatch(firstSystemPrompt, new RegExp(workspacePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(
    await fs.readFile(path.join(workspacePath, "test/from-agent.txt"), "utf8"),
    "written-by-pi\n",
  );
  assert.ok(
    requests[1].messages?.some((message) => message.role === "tool"),
    "Pi must send the write tool result back to the provider.",
  );
  assert.doesNotMatch(
    JSON.stringify(requests[1].messages),
    /internal reasoning must not be replayed/,
    "Pi must not replay historical reasoning in the tool follow-up request.",
  );
  const firstToolFollowUp = requests[1].messages?.find((message) => message.role === "assistant");
  assert.equal(firstToolFollowUp?.reasoning_content, undefined);
  assert.equal(firstToolFollowUp?.reasoning, undefined);
  assert.equal(firstToolFollowUp?.reasoning_text, undefined);
  assert.equal(firstToolFollowUp?.reasoning_details, undefined);

  const secondRequestMessages = requests[2].messages ?? [];
  const conversation = secondRequestMessages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => [message.role, contentText(message.content)])
    .filter(([, content]) => content);
  assert.deepEqual(conversation, [
    ["user", "first-prompt"],
    ["assistant", "first-answer"],
    ["user", "second-prompt"],
  ]);
  assert.doesNotMatch(
    JSON.stringify(secondRequestMessages),
    /internal reasoning must not be replayed/,
    "Pi must not replay historical reasoning in the next user turn.",
  );
  const secondTurnAssistant = secondRequestMessages.find((message) => message.role === "assistant");
  assert.equal(secondTurnAssistant?.reasoning_content, undefined);

  const history = await readPiSessionHistory(
    workspacePath,
    workspacePath,
    chatSession.sessionId,
  );
  assert.deepEqual(
    history?.map((message) => [message.role, message.content]),
    [
      ["user", "first-prompt"],
      ["assistant", "first-answer"],
      ["user", "second-prompt"],
      ["assistant", "second-answer"],
    ],
  );
  assert.deepEqual(
    history?.map((message) => message.runId),
    ["run-first", "run-first", "run-second", "run-second"],
  );
  assert.ok(
    store.traces.some(({ trace }) => trace.stepName === "pi:assistant_message"),
  );
  const toolTraces = store.traces.filter(({ trace }) => trace.stepName === "pi:tool:write");
  assert.equal(toolTraces.length, 2);
  assert.ok(
    toolTraces.every(({ trace }) => trace.debugMarkdown?.includes("call-write")),
    "Tool start and end traces must retain their shared Pi tool call ID.",
  );
});

test("Pi runtime uses the review prompt and exposes only read-only review tools", async (context) => {
  const requests: CapturedRequest[] = [];
  const provider = await startModelSwitchSuccessProvider(requests);
  context.after(() => provider.server.close());
  const workspacePath = path.join(process.env.WORKSPACE_ROOT!, "pi-review-runtime", "teacher", "project");
  const auditPath = path.join(process.env.WORKSPACE_ROOT!, "pi-review-runtime", "teacher", "audit");
  const studentRoot = path.join(process.env.WORKSPACE_ROOT!, "pi-review-runtime", "student");
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(auditPath, { recursive: true });
  await fs.mkdir(studentRoot, { recursive: true });
  const now = new Date().toISOString();
  const runtime = new PiCodingAgentRuntime(new FakeAgentRunStore());
  const systemPrompt = [
    "Current mode is teacher review mode.",
    "There are 3 readable student workspaces.",
    "Each .eva_history directory records all Agent Runs.",
  ].join("\n");

  await runtime.run({
    runId: "run-review-prompt",
    userId: "teacher-review",
    workspacePath,
    cwd: auditPath,
    mode: "review",
    systemPrompt,
    readableWorkspaceRoots: [studentRoot],
    prompt: "批量总结学生进度",
    aiSettings: {
      apiKey: "test-key",
      baseUrl: provider.baseUrl,
      model: "mock-model",
      contextWindowTokens: 16_384,
    },
    chatSession: {
      sessionId: "77777777-7777-4777-8777-777777777777",
      sessionKey: "course:courseworks-review:user:teacher-review",
      title: "Review test",
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
      status: "active",
    },
  });

  const sentSystemPrompt = (requests[0]?.messages ?? [])
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => contentText(message.content))
    .join("\n");
  assert.match(sentSystemPrompt, /3 readable student workspaces/);
  assert.match(sentSystemPrompt, /\.eva_history directory records all Agent Runs/);
  assert.match(sentSystemPrompt, /LLM model: "mock-model"/);
  assert.doesNotMatch(sentSystemPrompt, /Operate only in the current student workspace/);
  assert.deepEqual(runtime.listTools("review").map((tool) => tool.name), ["ls", "grep", "read"]);
});

/**
 * 功能：验证 outbound context 清理普通 thinking 文本、结构化 block 和 reasoning 字段，同时保留工具调用。
 * 输入：测试体构造带有内部 reasoning、普通文本和 tool call 的 assistant 消息。
 * 输出：断言通过时测试成功；断言失败时由 Node test runner 报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("Pi outbound context strips reasoning while preserving assistant text and tool calls", () => {
  const assistant = {
    role: "assistant" as const,
    content: [
      { type: "thinking" as const, thinking: "structured internal reasoning" },
      { type: "text" as const, text: "<thinking>literal internal reasoning</thinking>继续执行。" },
      { type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "README.md" } },
    ],
    api: "openai-completions" as const,
    provider: "courseworks-openai-compatible",
    model: "gpt-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse" as const,
    timestamp: Date.now(),
    reasoning_content: "top-level reasoning",
    reasoning_details: [{ type: "text", text: "top-level details" }],
  };
  const sanitized = sanitizeOutboundContext({ messages: [assistant] }, false);
  const cleaned = sanitized.context.messages[0];
  assert.equal(sanitized.strippedThinkingBlocks, 1);
  assert.equal(sanitized.strippedThinkingMarkup, 1);
  assert.equal(sanitized.strippedReasoningFields, 2);
  assert.equal(cleaned.role, "assistant");
  assert.deepEqual(cleaned.content, [
    { type: "text", text: "继续执行。" },
    { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
  ]);
  assert.equal((cleaned as typeof assistant).reasoning_content, undefined);
  assert.equal((cleaned as typeof assistant).reasoning_details, undefined);
});

/**
 * 功能：验证 provider 明确要求 reasoning continuation 时不清理协议字段。
 * 输入：测试框架提供测试上下文，测试体构造带 reasoning 字段的 assistant 消息。
 * 输出：断言通过时测试成功；断言失败时由 Node test runner 报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("Pi outbound context preserves reasoning for providers that require continuation", () => {
  const assistant = {
    role: "assistant" as const,
    content: [{ type: "thinking" as const, thinking: "provider-required reasoning" }],
    api: "openai-completions" as const,
    provider: "courseworks-openai-compatible",
    model: "deepseek-reasoner",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
    reasoning_content: "provider-required reasoning",
  };
  const preserved = sanitizeOutboundContext({ messages: [assistant] }, true);
  assert.equal(preserved.strippedThinkingBlocks, 0);
  assert.equal(preserved.strippedReasoningFields, 0);
  assert.equal(preserved.context.messages[0], assistant);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("Pi runtime produces an evidence-based fallback when the final assistant message is empty", async (context) => {
  const requests: CapturedRequest[] = [];
  const provider = await startMockProvider(requests, { emptyFinalAfterTool: true });
  context.after(() => provider.server.close());

  const workspacePath = path.join(
    process.env.WORKSPACE_ROOT!,
    "pi-runtime-empty-final",
    "workspace",
  );
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const now = new Date().toISOString();
  const store = new FakeAgentRunStore();
  const runtime = new PiCodingAgentRuntime(store);
  const answer = await runtime.run({
    runId: "run-empty-final",
    userId: "user-test",
    workspacePath,
    cwd: workspacePath,
    prompt: "请修改文件并验证。",
    aiSettings: {
      apiKey: "test-key",
      baseUrl: provider.baseUrl,
      model: "mock-model",
      contextWindowTokens: 16_384,
    },
    chatSession: {
      sessionId: "33333333-3333-4333-8333-333333333333",
      sessionKey: "course:test:user:empty-final",
      title: "Pi empty final test",
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
      status: "active",
    },
  });

  assert.match(answer, /任务执行结束/);
  assert.match(answer, /正在检查并修改文件/);
  assert.match(answer, /最后工具结果：write/);
  assert.ok(
    store.responses.some(({ markdown }) => markdown.includes("正在检查并修改文件")),
    "The streamed assistant text must reach the run store before completion.",
  );
  assert.equal(store.failed.length, 0);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("Pi runtime completes a greeting without requiring a tool call", async (context) => {
  const provider = await startSingleResponseProvider({
    content: "你好，我可以帮你处理课程工程。",
    finishReason: "stop",
  });
  context.after(() => provider.server.close());
  const workspacePath = path.join(process.env.WORKSPACE_ROOT!, "pi-runtime-greeting", "workspace");
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const now = new Date().toISOString();
  const store = new FakeAgentRunStore();
  const runtime = new PiCodingAgentRuntime(store);

  const answer = await runtime.run({
    runId: "run-greeting",
    userId: "user-test",
    workspacePath,
    cwd: workspacePath,
    prompt: "你好",
    aiSettings: {
      apiKey: "test-key",
      baseUrl: provider.baseUrl,
      model: "mock-model",
      contextWindowTokens: 16_384,
    },
    chatSession: {
      sessionId: "44444444-4444-4444-8444-444444444444",
      sessionKey: "course:test:user:greeting",
      title: "Greeting",
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
      status: "active",
    },
  });

  assert.equal(answer, "你好，我可以帮你处理课程工程。");
  assert.equal(store.completed.length, 1);
  assert.equal(store.failed.length, 0);
  assert.equal(store.traces.some(({ trace }) => trace.stepName?.startsWith("pi:tool:")), false);
});

/**
 * 功能：验证视觉模型收到真正的 OpenAI 图片内容块。
 * 输入：带有图片 Base64 数据的 Agent Run，以及支持视觉输入的 GPT 模型。
 * 输出：发送给 Provider 的 user message 同时包含文本和 image_url 内容。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用；内部调用 `PiCodingAgentRuntime.run()`、`session.prompt()`。
 */
test("Pi runtime sends image content to a vision model", async (context) => {
  const requests: string[] = [];
  const provider = await startSingleResponseProvider({
    content: "我看到了图片。",
    finishReason: "stop",
    requests,
  });
  context.after(() => provider.server.close());
  const workspacePath = path.join(process.env.WORKSPACE_ROOT!, "pi-runtime-image", "workspace");
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const now = new Date().toISOString();
  const runtime = new PiCodingAgentRuntime(new FakeAgentRunStore());

  await runtime.run({
    runId: "run-image",
    userId: "user-test",
    workspacePath,
    cwd: workspacePath,
    prompt: "请描述这张图片。",
    images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
    aiSettings: {
      apiKey: "test-key",
      baseUrl: provider.baseUrl,
      model: "gpt-5.6-sol",
      contextWindowTokens: 16_384,
    },
    chatSession: {
      sessionId: "99999999-9999-4999-8999-999999999999",
      sessionKey: "course:test:user:image",
      title: "Image input",
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
      status: "active",
    },
  });

  const request = JSON.parse(requests[0] ?? "{}") as {
    messages?: Array<{ role: string; content?: unknown }>;
  };
  const userMessage = request.messages?.find((message) => message.role === "user");
  assert.ok(userMessage && Array.isArray(userMessage.content));
  assert.ok(userMessage.content.some((part) => (
    typeof part === "object"
    && part !== null
    && (part as { type?: unknown }).type === "image_url"
  )));
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("Pi runtime persists streamed model thinking separately from visible text", async (context) => {
  const provider = await startThinkingResponseProvider();
  context.after(() => provider.server.close());
  const workspacePath = path.join(process.env.WORKSPACE_ROOT!, "pi-runtime-thinking", "workspace");
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const now = new Date().toISOString();
  const store = new FakeAgentRunStore();
  const runtime = new PiCodingAgentRuntime(store);

  const answer = await runtime.run({
    runId: "run-thinking",
    userId: "user-test",
    workspacePath,
    cwd: workspacePath,
    prompt: "继续任务",
    aiSettings: {
      apiKey: "test-key",
      baseUrl: provider.baseUrl,
      model: "DeepSeek-V4-Pro",
      contextWindowTokens: 16_384,
    },
    chatSession: {
      sessionId: "88888888-8888-4888-8888-888888888888",
      sessionKey: "course:test:user:thinking",
      title: "Thinking stream",
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
      status: "active",
    },
  });

  assert.equal(answer, "任务已经完成。");
  assert.ok(store.responses.some(({ markdown }) =>
    markdown.includes("courseworks-thinking:start")
    && markdown.includes("先检查工程，再执行修改。")
    && markdown.includes("任务已经完成。")));
  assert.ok(store.traces.some(({ trace }) =>
    trace.stepName === "pi:assistant_thinking"
    && trace.outputSummaryMarkdown?.includes("先检查工程")));
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("Pi runtime aborts and fails a stalled model request", async (context) => {
  const provider = await startStalledProvider();
  context.after(() => {
    provider.server.closeAllConnections();
    provider.server.close();
  });
  const workspacePath = path.join(process.env.WORKSPACE_ROOT!, "pi-runtime-timeout", "workspace");
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const now = new Date().toISOString();
  const store = new FakeAgentRunStore();
  const runtime = new PiCodingAgentRuntime(store, 30);

  await assert.rejects(runtime.run({
    runId: "run-timeout",
    userId: "user-test",
    workspacePath,
    cwd: workspacePath,
    prompt: "继续任务",
    aiSettings: {
      apiKey: "test-key",
      baseUrl: provider.baseUrl,
      model: "mock-model",
      contextWindowTokens: 16_384,
    },
    chatSession: {
      sessionId: "99999999-9999-4999-8999-999999999999",
      sessionKey: "course:test:user:timeout",
      title: "Timeout",
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
      status: "active",
    },
  }), /模型单次响应超过 1 秒/);

  assert.equal(store.completed.length, 0);
  assert.equal(store.failed.length, 1);
  assert.match(store.failed[0].message, /系统已中止本轮任务/);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("Pi runtime marks a length-limited response as failed", async (context) => {
  const provider = await startSingleResponseProvider({ finishReason: "length" });
  context.after(() => provider.server.close());
  const workspacePath = path.join(process.env.WORKSPACE_ROOT!, "pi-runtime-length", "workspace");
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const now = new Date().toISOString();
  const store = new FakeAgentRunStore();
  const runtime = new PiCodingAgentRuntime(store);

  await assert.rejects(
    runtime.run({
      runId: "run-length",
      userId: "user-test",
      workspacePath,
      cwd: workspacePath,
      prompt: "继续完成任务",
      aiSettings: {
        apiKey: "test-key",
        baseUrl: provider.baseUrl,
        model: "mock-model",
        contextWindowTokens: 16_384,
      },
      chatSession: {
        sessionId: "55555555-5555-4555-8555-555555555555",
        sessionKey: "course:test:user:length",
        title: "Length limited",
        createdAt: now,
        updatedAt: now,
        turnCount: 0,
        status: "active",
      },
    }),
    /自动预算上限/,
  );

  assert.equal(store.completed.length, 0);
  assert.equal(store.failed.length, 1);
  assert.match(store.failed[0].message, /自动预算上限/);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("Pi runtime switches from DeepSeek-V4-Pro to GLM-5.2 in the same short session", async (context) => {
  const requests: CapturedRequest[] = [];
  const provider = await startModelSwitchSuccessProvider(requests);
  context.after(() => provider.server.close());
  const workspacePath = path.join(
    process.env.WORKSPACE_ROOT!,
    "pi-runtime-model-switch-success",
    "workspace",
  );
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const now = new Date().toISOString();
  const chatSession: StudentSession = {
    sessionId: "77777777-7777-4777-8777-777777777777",
    sessionKey: "course:test:user:model-switch-success",
    title: "Successful model switch",
    createdAt: now,
    updatedAt: now,
    turnCount: 0,
    status: "active",
  };
  const store = new FakeAgentRunStore();
  const runtime = new PiCodingAgentRuntime(store);
  const common = {
    userId: "user-test",
    workspacePath,
    cwd: workspacePath,
    aiSettings: {
      apiKey: "test-key",
      baseUrl: provider.baseUrl,
      model: "DeepSeek-V4-Pro",
      contextWindowTokens: 16_384,
    },
    chatSession,
  };

  const first = await runtime.run({
    ...common,
    runId: "run-deepseek",
    prompt: "prompt-for-deepseek",
  });
  const second = await runtime.run({
    ...common,
    runId: "run-glm-success",
    prompt: "prompt-for-glm",
    aiSettings: { ...common.aiSettings, model: "GLM-5.2" },
  });

  assert.equal(first, "DeepSeek-V4-Pro-answer");
  assert.equal(second, "GLM-5.2-answer");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, "DeepSeek-V4-Pro");
  assert.equal(requests[1].model, "GLM-5.2");
  assert.equal(requests[0].thinking?.type, "enabled");
  assert.equal(requests[0].reasoning_effort, "high");
  assert.equal(requests[1].thinking?.type, "enabled");
  assert.equal(requests[1].reasoning_effort, undefined);
  const conversation = (requests[1].messages ?? [])
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => [message.role, contentText(message.content)]);
  assert.deepEqual(conversation, [
    ["user", "prompt-for-deepseek"],
    ["assistant", "DeepSeek-V4-Pro-answer"],
    ["user", "prompt-for-glm"],
  ]);
  const reopened = await openPiSession(workspacePath, workspacePath, chatSession.sessionId);
  assert.equal(getPiSessionModelConfiguration(reopened.sessionManager)?.model, "GLM-5.2");
  assert.equal(store.completed.length, 2);
  assert.equal(store.failed.length, 0);
  assert.ok(store.traces.some(({ trace }) => trace.stepName === "pi:model_change"));
});

test("Pi runtime sends the configured GPT-5.6 maximum reasoning effort", async (context) => {
  const requests: CapturedRequest[] = [];
  const provider = await startModelSwitchSuccessProvider(requests);
  context.after(() => provider.server.close());
  const workspacePath = path.join(
    process.env.WORKSPACE_ROOT!,
    "pi-runtime-reasoning-effort",
    "workspace",
  );
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const now = new Date().toISOString();
  const chatSession: StudentSession = {
    sessionId: "88888888-8888-4888-8888-888888888888",
    sessionKey: "course:test:user:reasoning-effort",
    title: "Reasoning effort",
    createdAt: now,
    updatedAt: now,
    turnCount: 0,
    status: "active",
  };
  const store = new FakeAgentRunStore();
  const runtime = new PiCodingAgentRuntime(store);

  await runtime.run({
    runId: "run-gpt-max",
    userId: "user-test",
    workspacePath,
    cwd: workspacePath,
    prompt: "reason carefully",
    aiSettings: {
      apiKey: "test-key",
      baseUrl: provider.baseUrl,
      model: "gpt-5.6-sol",
      contextWindowTokens: 16_384,
      reasoningEffort: "max",
    },
    chatSession,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].reasoning_effort, "max");
  assert.equal(store.failed.length, 0);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("Pi runtime preserves DeepSeek session when GLM-5.2 compaction fails", async (context) => {
  const requests: CapturedRequest[] = [];
  const provider = await startCompactionFailureProvider(requests);
  context.after(() => provider.server.close());
  const workspacePath = path.join(
    process.env.WORKSPACE_ROOT!,
    "pi-runtime-model-switch",
    "workspace",
  );
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const now = new Date().toISOString();
  const chatSession: StudentSession = {
    sessionId: "66666666-6666-4666-8666-666666666666",
    sessionKey: "course:test:user:model-switch",
    title: "Model switch",
    createdAt: now,
    updatedAt: now,
    turnCount: 0,
    status: "active",
  };
  const store = new FakeAgentRunStore();
  const runtime = new PiCodingAgentRuntime(store);
  const common = {
    userId: "user-test",
    workspacePath,
    cwd: workspacePath,
    aiSettings: {
      apiKey: "test-key",
      baseUrl: provider.baseUrl,
      model: "DeepSeek-V4-Pro",
      contextWindowTokens: 16_384,
    },
    chatSession,
  };

  for (let index = 1; index <= 3; index += 1) {
    await runtime.run({
      ...common,
      runId: `run-history-${index}`,
      prompt: `history-prompt-${index}\n${"context ".repeat(2_500)}`,
    });
  }
  const requestCountBeforeModelSwitch = requests.length;

  await assert.rejects(
    runtime.run({
      ...common,
      runId: "run-model-b",
      prompt: "new-task-must-not-be-sent",
      aiSettings: { ...common.aiSettings, model: "GLM-5.2" },
    }),
    /原 Pi Session 已保留.*没有创建新 Session.*切回之前的模型/s,
  );

  assert.ok(
    requests.length > requestCountBeforeModelSwitch,
    `Model B must be used for the attempted compaction: ${store.failed.at(-1)?.message ?? "no failure"}`,
  );
  assert.deepEqual(
    requests.slice(requestCountBeforeModelSwitch).map((request) => request.model),
    ["GLM-5.2"],
    "GLM-5.2 must perform the model-switch compaction request.",
  );
  assert.equal(
    requests.slice(requestCountBeforeModelSwitch).some(({ messages }) =>
      messages?.some((message) => contentText(message.content).includes("new-task-must-not-be-sent"))),
    false,
    "The new user prompt must not be sent after compaction fails.",
  );
  const reopened = await openPiSession(workspacePath, workspacePath, chatSession.sessionId);
  assert.equal(getPiSessionModelConfiguration(reopened.sessionManager)?.model, "DeepSeek-V4-Pro");
  assert.equal(store.completed.length, 3);
  assert.equal(store.failed.at(-1)?.runId, "run-model-b");
});
