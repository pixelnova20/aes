/**
 * 文件作用：验证前端“工作台”功能模块中的关键行为和回归场景。
 * 模块位置：`apps/web/src/features/workspace/agent-run-activity.test.ts`，属于前端“工作台”功能模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentRunActivity } from "./agent-run-activity.js";

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("pairs tool start and end traces while preserving arguments and output", () => {
  const activity = buildAgentRunActivity({
    id: "run-1",
    prompt: "请检查并编译程序",
    traceEvents: [
      {
        id: "assistant-1",
        stepName: "pi:assistant_message",
        stepStatus: "success",
        outputSummaryMarkdown: "我先检查构建配置。",
      },
      {
        id: "tool-start",
        stepName: "pi:tool:bash",
        stepStatus: "running",
        inputSummaryMarkdown: '`{"command":"make test"}`',
        debugMarkdown: '{"toolCallId":"call-1"}',
      },
      {
        id: "tool-end",
        stepName: "pi:tool:bash",
        stepStatus: "success",
        outputSummaryMarkdown: "all tests passed",
        debugMarkdown: '{"toolCallId":"call-1"}',
      },
    ],
  }, "");

  assert.equal(activity.length, 2);
  assert.equal(activity[0].kind, "assistant");
  assert.match(activity[0].detail, /我先检查构建配置/);
  assert.equal(activity[1].id, "trace-tool-start");
  assert.equal(activity[1].status, "success");
  assert.match(activity[1].summary, /make test/);
  assert.match(activity[1].detail, /输入[\s\S]*make test/);
  assert.match(activity[1].detail, /输出[\s\S]*all tests passed/);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("shows a running tool call before its result arrives", () => {
  const activity = buildAgentRunActivity({
    id: "run-live",
    prompt: "build",
    traceEvents: [
      {
        id: "tool-live",
        stepName: "pi:tool:write",
        stepStatus: "running",
        inputSummaryMarkdown: '`{"path":"src/main.c","content":"int main(void) { return 0; }"}`',
      },
    ],
  }, "");

  assert.equal(activity.length, 1);
  assert.equal(activity[0].status, "running");
  assert.match(activity[0].summary, /src\/main.c/);
  assert.match(activity[0].detail, /int main/);
});

test("shows project-relative file targets without serializing edit objects", () => {
  const activity = buildAgentRunActivity({
    id: "run-edit-target",
    prompt: "请修改构建文件",
    traceEvents: [{
      id: "tool-edit",
      stepName: "pi:tool:edit",
      stepStatus: "success",
      inputSummaryMarkdown: JSON.stringify({
        path: "/home/runner/project/kernel/main.c",
        edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: "d" }],
      }),
    }],
  }, "");

  assert.match(activity[0].summary, /edit · kernel\/main\.c · 2 处编辑/);
  assert.doesNotMatch(activity[0].summary, /\[object Object\]|home\/runner\/project/);
});

test("summarizes write tools with the target path but not file content", () => {
  const activity = buildAgentRunActivity({
    id: "run-write-target",
    prompt: "write",
    traceEvents: [{
      id: "tool-write",
      stepName: "pi:tool:write",
      stepStatus: "running",
      inputSummaryMarkdown: JSON.stringify({
        path: "project/kernel/term/terminal.c",
        content: "a very long source file body",
      }),
    }],
  }, "");

  assert.match(activity[0].summary, /write · kernel\/term\/terminal\.c/);
  assert.doesNotMatch(activity[0].summary, /source file body|content=/);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("shows model thinking as a distinct activity entry", () => {
  const activity = buildAgentRunActivity({
    id: "run-thinking",
    prompt: "请继续实现",
    traceEvents: [{
      id: "thinking-1",
      stepName: "pi:assistant_thinking",
      stepStatus: "success",
      outputSummaryMarkdown: "先分析现有目录，再决定修改哪些文件。",
    }],
  }, "");

  assert.equal(activity.length, 1);
  assert.equal(activity[0].kind, "thinking");
  assert.match(activity[0].summary, /模型思考/);
  assert.match(activity[0].detail, /分析现有目录/);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("keeps intermediate assistant updates but leaves the final answer to the message body", () => {
  const activity = buildAgentRunActivity({
    id: "run-answer",
    prompt: "请修复程序",
    traceEvents: [
      {
        id: "assistant-progress",
        stepName: "pi:assistant_message",
        stepStatus: "success",
        outputSummaryMarkdown: "我先检查源文件。",
      },
      {
        id: "assistant-final",
        stepName: "pi:assistant_message",
        stepStatus: "success",
        outputSummaryMarkdown: "程序已经修复并通过测试。",
      },
    ],
  }, "程序已经修复并通过测试。");

  assert.equal(activity.length, 1);
  assert.match(activity[0].detail, /检查源文件/);
});
