/**
 * 文件作用：验证后端“Coding Agent 与 Pi 适配”业务模块中的关键行为和回归场景。
 * 模块位置：`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.test.ts`，属于后端“Coding Agent 与 Pi 适配”业务模块。
 * 重要函数：`createLegacySession()` 负责创建`legacy` 会话。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  appendTurnRecord,
  writeSessionCreatedRecord,
} from "../../../conversations/index.js";
import type { StudentSession } from "../../../conversations/index.js";
import {
  getPiSessionModelConfiguration,
  modelConfigurationChanged,
  openPiSession,
  piSessionPath,
  readPiSessionContextUsage,
  readPiSessionHistory,
  recordPiSessionModelConfiguration,
  retainPiSessions,
} from "./pi-session-store.js";

const testRoot = process.env.WORKSPACE_ROOT!;
const workspacePath = path.join(testRoot, "pi-session-store", "workspace");

/**
 * 功能：创建`legacy` 会话。
 * 输入：无显式输入参数。
 * 输出：返回 StudentSession，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.test.ts 顶层流程` 调用；内部调用 `toISOString()`。
 */
function createLegacySession(): StudentSession {
  const now = new Date().toISOString();
  return {
    sessionId: "11111111-1111-4111-8111-111111111111",
    sessionKey: "course:test:user:test",
    title: "Legacy session",
    createdAt: now,
    updatedAt: now,
    turnCount: 2,
    status: "active",
  };
}

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("migrates a legacy transcript once and restores both sides of the conversation", async () => {
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const session = createLegacySession();
  await writeSessionCreatedRecord(workspacePath, session, workspacePath, "auto_first_login");
  await appendTurnRecord(workspacePath, session, {
    role: "user",
    content: "请创建 test 目录",
  });
  await appendTurnRecord(workspacePath, session, {
    role: "assistant",
    content: "已经创建 test 目录。",
  });

  const first = await openPiSession(workspacePath, workspacePath, session.sessionId);
  assert.equal(first.migratedMessages, 2);
  assert.equal(first.sessionManager.buildSessionContext().messages.length, 2);
  await fs.access(piSessionPath(workspacePath, session.sessionId));

  const second = await openPiSession(workspacePath, workspacePath, session.sessionId);
  assert.equal(second.migratedMessages, 0);
  const history = await readPiSessionHistory(
    workspacePath,
    workspacePath,
    session.sessionId,
  );
  assert.deepEqual(
    history?.map((message) => [message.role, message.content]),
    [
      ["user", "请创建 test 目录"],
      ["assistant", "已经创建 test 目录。"],
    ],
  );
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("records only a successfully adopted provider configuration", async () => {
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const session = createLegacySession();
  const opened = await openPiSession(workspacePath, workspacePath, session.sessionId);
  const configuration = {
    provider: "courseworks-openai-compatible",
    model: "DeepSeek-V4-Pro",
    baseUrl: "https://provider.example/v1",
  };

  assert.equal(getPiSessionModelConfiguration(opened.sessionManager), null);
  recordPiSessionModelConfiguration(opened.sessionManager, configuration);
  assert.deepEqual(getPiSessionModelConfiguration(opened.sessionManager), configuration);
  assert.equal(modelConfigurationChanged(configuration, configuration), false);
  assert.equal(
    modelConfigurationChanged(configuration, { ...configuration, model: "GLM-5.2" }),
    true,
  );

  const entryCount = opened.sessionManager.getEntries().length;
  recordPiSessionModelConfiguration(opened.sessionManager, configuration);
  assert.equal(opened.sessionManager.getEntries().length, entryCount);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("moves a failed thinking-only tail off the active session branch", async () => {
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const session = createLegacySession();
  const opened = await openPiSession(workspacePath, workspacePath, session.sessionId);
  opened.sessionManager.appendCustomEntry("courseworks.agent-run", { runId: "failed-run" });
  opened.sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "继续实现工程" }],
    timestamp: Date.now(),
  });
  opened.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "thinking", thinking: "持续思考但没有调用工具" }],
    api: "openai-completions",
    provider: "courseworks-openai-compatible",
    model: "GLM-5.2",
    usage: {
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    timestamp: Date.now(),
  });

  const recovered = await openPiSession(workspacePath, workspacePath, session.sessionId);
  assert.equal(recovered.recoveredThinkingRuns, 1);
  assert.equal(recovered.sessionManager.buildSessionContext().messages.length, 0);
  assert.equal(
    recovered.sessionManager.getBranch().at(-1)?.type,
    "custom",
  );
  const history = await readPiSessionHistory(workspacePath, workspacePath, session.sessionId);
  assert.deepEqual(history, []);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("estimates context usage from the active Pi session branch", async () => {
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const session = createLegacySession();
  const opened = await openPiSession(workspacePath, workspacePath, session.sessionId);
  opened.sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Inspect the workspace." }],
    timestamp: Date.now(),
  });
  opened.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "I will inspect it." }],
    api: "openai-completions",
    provider: "courseworks-openai-compatible",
    model: "mock-model",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  opened.sessionManager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "Now compile it." }],
    timestamp: Date.now(),
  });

  const usage = await readPiSessionContextUsage(
    workspacePath,
    workspacePath,
    session.sessionId,
    1_000,
  );
  assert.ok(usage.tokens !== null && usage.tokens > 120);
  assert.equal(usage.contextWindow, 1_000);
  assert.equal(usage.percent, (usage.tokens / 1_000) * 100);
});

test("retains Pi runtime files for only selected sessions", async () => {
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const oldSession = await openPiSession(workspacePath, workspacePath, "session-old");
  oldSession.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "old" }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const latestSession = await openPiSession(workspacePath, workspacePath, "session-latest");
  latestSession.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "latest" }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  });

  const result = await retainPiSessions(workspacePath, ["session-latest"]);

  assert.equal(result.removedFiles, 1);
  await assert.rejects(fs.access(piSessionPath(workspacePath, "session-old")));
  await fs.access(piSessionPath(workspacePath, "session-latest"));
});
