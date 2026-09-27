/**
 * 文件作用：验证后端“课程评价历史”业务模块中的关键行为和回归场景。
 * 模块位置：`apps/server/src/modules/evaluation-history/evaluation-history.service.test.ts`，属于后端“课程评价历史”业务模块。
 * 重要函数：`snapshot()` 负责处理`snapshot`。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  ensureEvaluationHistory,
  evaluationHistoryFilePath,
  evaluationHistoryRoot,
  evaluationToolName,
  renderEvaluationHistory,
  retainLatestPastSessionArchive,
  type EvaluationHistorySnapshot,
  writeEvaluationHistorySnapshot,
} from "./evaluation-history.service.js";

const workspacePath = path.join(
  process.env.WORKSPACE_ROOT!,
  "evaluation-history-test",
  "project",
);

/**
 * 功能：处理`snapshot`。
 * 输入：无显式输入参数。
 * 输出：返回 EvaluationHistorySnapshot，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/evaluation-history/evaluation-history.service.test.ts 顶层流程` 调用。
 */
function snapshot(): EvaluationHistorySnapshot {
  return {
    generatedAt: "2026-07-30T12:00:00.000Z",
    studentEmail: "student@example.com",
    workspaceUuid: "evaluation-history-test",
    workspaceStatus: "ready",
    courseTasks: [
      {
        title: "Kernel coursework",
        status: "active",
        createdAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T11:00:00.000Z",
        summary: "Implemented the first kernel milestone.",
        subtasks: [
          {
            title: "Boot code",
            status: "done",
            goal: "Create the boot path.",
            validation: "make completed successfully",
            buildStatus: "success",
            qemuStatus: "success",
            files: ["kernel/boot/main.c"],
          },
        ],
      },
    ],
    conversations: [
      {
        sessionId: "session-test",
        title: "Build boot code",
        status: "active",
        createdAt: "2026-07-30T10:00:00.000Z",
        updatedAt: "2026-07-30T11:00:00.000Z",
        userPrompts: [
          {
            content: "Please implement the boot code.",
            createdAt: "2026-07-30T10:05:00.000Z",
          },
        ],
        assistantMessages: 1,
      },
    ],
    runs: [
      {
        id: "run-test",
        status: "completed",
        prompt: "Please implement the boot code.",
        finalAnswer: "Implemented and verified the boot code.",
        createdAt: "2026-07-30T10:05:00.000Z",
        finishedAt: "2026-07-30T10:10:00.000Z",
        tools: ["read", "write", "bash"],
        retries: 0,
        compactions: 0,
        build: {
          status: "success",
          command: "make",
          exitCode: 0,
          summary: "Build passed.",
        },
      },
    ],
    checkpoints: [],
  };
}

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("evaluation history preserves legacy records and writes a managed coursework summary", async (context) => {
  const workspaceHome = path.dirname(workspacePath);
  context.after(() => fs.rm(workspaceHome, { recursive: true, force: true }));
  await fs.rm(workspaceHome, { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(evaluationHistoryRoot(workspacePath), { recursive: true });
  await fs.writeFile(evaluationHistoryFilePath(workspacePath), "# Legacy evaluation\n");

  const filePath = await writeEvaluationHistorySnapshot(workspacePath, snapshot());
  const content = await fs.readFile(filePath, "utf8");
  const legacy = await fs.readFile(
    path.join(evaluationHistoryRoot(workspacePath), "session-history.legacy.md"),
    "utf8",
  );
  const mode = (await fs.stat(filePath)).mode & 0o777;

  assert.match(content, /Student Coursework Evaluation History/);
  assert.match(content, /Kernel coursework/);
  assert.match(content, /Please implement the boot code/);
  assert.match(content, /Tools.*read, write, bash/);
  assert.equal(legacy, "# Legacy evaluation\n");
  assert.equal(mode, 0o600);

  await ensureEvaluationHistory(workspacePath);
  assert.equal(await fs.readFile(filePath, "utf8"), content);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("evaluation history recognizes old and Pi tool trace names", () => {
  assert.equal(evaluationToolName("tool:read_file"), "read_file");
  assert.equal(evaluationToolName("pi:tool:read"), "read");
  assert.equal(evaluationToolName("pi:assistant_message"), null);
});

test("evaluation history renders the active session, run metadata, validation, and attachment links", () => {
  const rendered = renderEvaluationHistory({
    ...snapshot(),
    currentSessionId: "session-test",
    courseInformation: {
      courseId: "os",
      courseTitle: "Operating Systems",
      courseworkTitle: "Kernel coursework",
      courseworkVersion: "v3",
      initializedAt: "2026-07-30T10:00:00.000Z",
    },
    conversations: [{
      ...snapshot().conversations[0],
      messages: [{
        id: "message-test",
        role: "user",
        content: "Please inspect this image and implement the boot path.",
        createdAt: "2026-07-30T10:05:00.000Z",
        runId: "run-test",
        attachments: [{
          id: "artifact-test",
          originalName: "screen.png",
          mimeType: "image/png",
          sizeBytes: 12,
          sha256: "abc123",
          relativePath: "artifact-test-screen.png",
          archived: false,
          runId: "run-test",
        }],
      }],
    }],
    runs: [{
      ...snapshot().runs[0],
      sessionId: "session-test",
      sequence: 7,
      modelName: "gpt-oss:120b",
      validations: [
        { kind: "build", status: "success", command: "make", exitCode: 0 },
        { kind: "qemu", status: "failed", command: "make run", exitCode: 1 },
      ],
    }],
    pastSessions: [{
      fileName: "20260730T110000Z_old-session.md",
      sessionId: "old-session",
      archivedAt: "2026-07-30T11:00:00.000Z",
      reason: "user_slash_new",
    }],
  });

  assert.match(rendered, /## Current Session/);
  assert.match(rendered, /Please inspect this image and implement the boot path/);
  assert.match(rendered, /Run 7/);
  assert.match(rendered, /gpt-oss:120b/);
  assert.match(rendered, /BUILD.*passed/);
  assert.match(rendered, /QEMU.*failed/);
  assert.match(rendered, /\.\.\/\.uploads\/artifact-test-screen\.png/);
  assert.match(rendered, /past_sessions\/20260730T110000Z_old-session\.md/);

  const archived = renderEvaluationHistory({
    ...snapshot(),
    currentSessionId: "session-test",
    conversations: [{
      ...snapshot().conversations[0],
      sessionId: "session-test",
      messages: [{
        id: "message-test",
        role: "user",
        content: "Archived prompt",
        createdAt: "2026-07-30T10:05:00.000Z",
        attachments: [{
          id: "artifact-test",
          originalName: "screen.png",
          mimeType: "image/png",
          sizeBytes: 12,
          sha256: "abc123",
          relativePath: "upload-screen.png",
          archived: false,
        }],
      }],
    }],
    runs: [{
      ...snapshot().runs[0],
      attachments: [{
        id: "artifact-test",
        originalName: "screen.png",
        mimeType: "image/png",
        sizeBytes: 12,
        sha256: "abc123",
        relativePath: "upload-screen.png",
        archived: false,
      }],
    }],
  }, { archive: true });
  assert.match(archived, /\.\.\/artifacts_history\/upload-screen\.png/);
});

test("retains only the latest past-session Markdown archive", async () => {
  const root = path.join(evaluationHistoryRoot(workspacePath), "past_sessions");
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "20260901-120000_session-old.md"), "old");
  await fs.writeFile(path.join(root, "20260902-120000_session-latest.md"), "latest");

  const result = await retainLatestPastSessionArchive(workspacePath, "session-latest");

  assert.equal(result.removedFiles, 1);
  assert.deepEqual(await fs.readdir(root), ["20260902-120000_session-latest.md"]);
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
});
