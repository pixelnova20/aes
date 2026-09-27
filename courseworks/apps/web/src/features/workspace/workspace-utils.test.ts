/**
 * 文件作用：验证前端“工作台”功能模块中的关键行为和回归场景。
 * 模块位置：`apps/web/src/features/workspace/workspace-utils.test.ts`，属于前端“工作台”功能模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  assistantEntryForRun,
  collapseAgentRunHistory,
  filesFromClipboardData,
  filterAgentRunsForChatSession,
  formatAgentContextUsage,
  formatTokenCount,
  navigatePromptHistory,
  nextStreamingTextFrame,
  parseAgentResponse,
} from "./workspace-utils.js";

test("advances appended streaming text in bounded readable chunks", () => {
  assert.equal(nextStreamingTextFrame("Summary: ", "Summary: completed"), "Summary: com");
  assert.equal(nextStreamingTextFrame("处理", "处理已经全部完成"), "处理已经全");
  assert.equal(nextStreamingTextFrame("A", "A😀BCDEFGHI"), "A😀BC");
});

test("applies a replaced streaming response immediately", () => {
  assert.equal(nextStreamingTextFrame("正在继续处理...", "## Summary\n\n已完成"), "## Summary\n\n已完成");
  assert.equal(nextStreamingTextFrame("已完成", "已完成"), "已完成");
});

test("uses only the clipboard items view when the same image also appears in files", () => {
  const itemImage = new File(["image"], "image.png", { type: "image/png", lastModified: 1 });
  const mirroredImage = new File(["image"], "image.png", { type: "image/png", lastModified: 2 });

  const files = filesFromClipboardData({
    items: [{ kind: "file", getAsFile: () => itemImage }] as unknown as DataTransferItemList,
    files: [mirroredImage] as unknown as FileList,
  });

  assert.deepEqual(files, [itemImage]);
});

test("falls back to clipboard files when items contains no file", () => {
  const fallbackFile = new File(["notes"], "notes.txt", { type: "text/plain" });

  const files = filesFromClipboardData({
    items: [{ kind: "string", getAsFile: () => null }] as unknown as DataTransferItemList,
    files: [fallbackFile] as unknown as FileList,
  });

  assert.deepEqual(files, [fallbackFile]);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("separates persisted model thinking from visible assistant text", () => {
  const parsed = parseAgentResponse([
    "<!-- courseworks-thinking:start -->",
    "先分析工程。",
    "<!-- courseworks-thinking:end -->",
    "已经完成修改。",
  ].join("\n\n"));

  assert.deepEqual(parsed, {
    thinking: "先分析工程。",
    content: "已经完成修改。",
  });
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("keeps legacy assistant responses unchanged", () => {
  assert.deepEqual(parseAgentResponse("普通回复"), {
    thinking: "",
    content: "普通回复",
  });
});

/**
 * 功能：验证登录恢复时同一 Agent Run 的中间 assistant 消息只保留最后一条。
 * 输入：包含同一 `runId` 的多条 assistant 历史消息，以及前后相邻的用户消息。
 * 输出：返回的历史保留用户消息和该轮最终 assistant 消息，不改变其他轮次。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用；内部调用 `collapseAgentRunHistory()`。
 */
test("collapses intermediate assistant messages from the same agent run", () => {
  const history = collapseAgentRunHistory([
    { id: "user-1", role: "user", content: "开始", createdAt: "2026-09-04T10:00:00Z", runId: "run-1" },
    { id: "assistant-1a", role: "assistant", content: "我先检查工程。", createdAt: "2026-09-04T10:00:01Z", runId: "run-1" },
    { id: "assistant-1b", role: "assistant", content: "## Summary\n\n已经完成。", createdAt: "2026-09-04T10:01:00Z", runId: "run-1" },
    { id: "user-2", role: "user", content: "继续", createdAt: "2026-09-04T10:02:00Z", runId: "run-2" },
    { id: "assistant-2", role: "assistant", content: "第二轮完成。", createdAt: "2026-09-04T10:02:01Z", runId: "run-2" },
  ]);

  assert.deepEqual(history.map((entry) => [entry.id, entry.content]), [
    ["user-1", "开始"],
    ["assistant-1b", "## Summary\n\n已经完成。"],
    ["user-2", "继续"],
    ["assistant-2", "第二轮完成。"],
  ]);
});

/**
 * 功能：验证新会话不会把旧会话的 Agent 运行记录显示在当前会话列表中。
 * 输入：包含新旧会话运行记录的列表、当前会话快照和当前前端聊天历史。
 * 输出：只返回当前会话中出现过的运行记录，并保留尚未同步到后端快照的新运行。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用；内部调用 `filterAgentRunsForChatSession()`。
 */
test("filters runs to the active chat session", () => {
  const runs = [
    { id: "run-new", status: "completed" },
    { id: "run-old", status: "completed" },
    { id: "run-live", status: "running" },
  ];
  const session = {
    currentSessionId: "session-new",
    session: { sessionId: "session-new", title: "当前会话", updatedAt: "2026-09-04T10:00:00Z" },
    sessions: [],
    history: [
      { id: "message-new", role: "user" as const, content: "你好", createdAt: "2026-09-04T10:00:00Z", runId: "run-new" },
    ],
    contextUsage: null,
  };

  assert.deepEqual(
    filterAgentRunsForChatSession(runs, session, [{ runId: "run-live" }]),
    [runs[0], runs[2]],
  );
});

/**
 * 功能：验证没有活动聊天会话时不会误显示用户以前的运行记录。
 * 输入：用户运行记录列表和空会话快照。
 * 输出：返回空列表。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用；内部调用 `filterAgentRunsForChatSession()`。
 */
test("hides all runs when there is no active chat session", () => {
  assert.deepEqual(
    filterAgentRunsForChatSession([{ id: "run-old", status: "completed" }], null),
    [],
  );
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("projects only unrecorded streaming text beside completed timeline events", () => {
  const entry = assistantEntryForRun("assistant-live", {
    id: "run-live",
    status: "planning",
    prompt: "请继续实现",
    responseMarkdown: [
      "<!-- courseworks-thinking:start -->",
      "先检查目录。\n\n然后修改当前文件。",
      "<!-- courseworks-thinking:end -->",
      "我先读取配置。\n\n正在准备修改。",
    ].join("\n\n"),
    traceEvents: [
      {
        id: "thinking-recorded",
        stepName: "pi:assistant_thinking",
        stepStatus: "success",
        outputSummaryMarkdown: "先检查目录。",
      },
      {
        id: "message-recorded",
        stepName: "pi:assistant_message",
        stepStatus: "success",
        outputSummaryMarkdown: "我先读取配置。",
      },
    ],
  });

  assert.equal(entry.thinking, "然后修改当前文件。");
  assert.equal(entry.content, "正在准备修改。");
  assert.equal(Array.isArray(entry.activity), true);
});

/**
 * 功能：验证工具时间线存在时不重复显示没有目标对象的通用工具 bullet。
 * 输入：进行中的 AgentRunView，包含工具 trace 和具体文件路径。
 * 输出：返回的 ChatEntry 只保留简短状态，具体工具参数由 activity 时间线展示。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用；内部调用 `assistantEntryForRun()`。
 */
test("avoids generic tool bullets when a detailed activity timeline is available", () => {
  const entry = assistantEntryForRun("assistant-tool-status", {
    id: "run-tool-status",
    status: "running",
    prompt: "请读取前置约束.md",
    responseMarkdown: "",
    traceEvents: [{
      id: "read-start",
      stepName: "pi:tool:read",
      stepStatus: "running",
      inputSummaryMarkdown: '`{"path":"前置约束.md","limit":400}`',
    }],
  });

  assert.equal(entry.content, "正在继续处理...");
  assert.doesNotMatch(entry.content, /Reading files|Running command/);
  assert.equal(Array.isArray(entry.activity), true);
  assert.match((entry.activity as Array<{ summary: string }>)[0].summary, /前置约束\.md/);
});

/**
 * 功能：验证Agent运行结束后聊天消息只保留最终回答。
 * 输入：已完成的 AgentRunView，包含中间 thinking 和 tool trace。
 * 输出：返回的 ChatEntry 不包含中间过程，避免历史聊天区重复显示完整运行轨迹。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用；内部调用 `assistantEntryForRun()`。
 */
test("removes intermediate activity after an agent run completes", () => {
  const entry = assistantEntryForRun("assistant-completed", {
    id: "run-completed",
    status: "completed",
    finishedAt: "2026-09-04T10:00:00.000Z",
    responseMarkdown: "## Summary\n\n已经完成。",
    finalAnswerMarkdown: "## Summary\n\n已经完成。",
    traceEvents: [
      {
        id: "thinking",
        stepName: "pi:assistant_thinking",
        stepStatus: "success",
        outputSummaryMarkdown: "内部分析不应出现在结束后的聊天消息中。",
      },
      {
        id: "tool",
        stepName: "pi:tool:write_file",
        stepStatus: "success",
        inputSummaryMarkdown: "write file",
        outputSummaryMarkdown: "file written",
      },
    ],
  });

  assert.equal(entry.content, "## Summary\n\n已经完成。");
  assert.equal(entry.activity, undefined);
  assert.equal(entry.thinking, undefined);
  assert.equal(entry.pending, undefined);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("formats context usage like the Pi TUI footer", () => {
  assert.equal(formatTokenCount(999), "999");
  assert.equal(formatTokenCount(4_096), "4.1K");
  assert.equal(formatTokenCount(128_000), "128K");
  assert.equal(formatTokenCount(1_000_000), "1.0M");
  assert.equal(formatAgentContextUsage({
    tokens: 42_300,
    contextWindow: 128_000,
    percent: 33.046875,
  }), "42K/128K · 33.0%");
  assert.equal(formatAgentContextUsage({
    tokens: null,
    contextWindow: 128_000,
    percent: null,
  }), "?/128K · ?");
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("navigates prompt history and restores the unsent draft", () => {
  const history = ["first prompt", "second prompt"];
  const initial = { index: null, draft: "" };

  const latest = navigatePromptHistory(history, "unfinished draft", initial, "older");
  assert.deepEqual(latest, {
    value: "second prompt",
    navigation: { index: 1, draft: "unfinished draft" },
  });

  const oldest = navigatePromptHistory(history, latest.value, latest.navigation, "older");
  assert.deepEqual(oldest, {
    value: "first prompt",
    navigation: { index: 0, draft: "unfinished draft" },
  });
  assert.deepEqual(
    navigatePromptHistory(history, oldest.value, oldest.navigation, "older"),
    oldest,
  );

  const newer = navigatePromptHistory(history, oldest.value, oldest.navigation, "newer");
  assert.deepEqual(newer, latest);
  assert.deepEqual(
    navigatePromptHistory(history, newer.value, newer.navigation, "newer"),
    { value: "unfinished draft", navigation: initial },
  );
  assert.equal(navigatePromptHistory([], "draft", initial, "older"), null);
  assert.equal(navigatePromptHistory(history, "draft", initial, "newer"), null);
});
