import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { config } from "../../config/index.js";
import {
  attachConsumedArtifactsToHistory,
  createNewChatSession,
  ensureActiveChatSession,
  getActiveChatSessionSnapshot,
  listChatSessions,
  retainChatSessions,
} from "./chat-session.service.js";
import { sessionStorePath, sessionTranscriptPath } from "./session-paths.js";
import { appendTurnRecord } from "./transcript-store.js";
import type { ConsumedArtifactRecord } from "../artifacts/index.js";

test("restores an archived image on a current run and hides its internal staging path", () => {
  const history = attachConsumedArtifactsToHistory([
    {
      id: "message-1",
      role: "user",
      content: "请读图\n\n[media attached: /home/runner/.uploads/upload-1-screen.png]",
      createdAt: "2026-09-08T00:00:00.000Z",
      runId: "run-1",
    },
  ], [{
    id: "artifact-1",
    kind: "consumed_upload",
    sessionId: "session-1",
    sessionKey: "course:os:user:user-1",
    runId: "run-1",
    sourceUploadId: "upload-1",
    originalName: "screen.png",
    storedName: "artifact-1-screen.png",
    artifactPath: "/archive/artifact-1-screen.png",
    mimeType: "image/png",
    sizeBytes: 123,
    sha256: "abc",
    createdAt: "2026-09-08T00:00:00.000Z",
  } satisfies ConsumedArtifactRecord]);

  assert.equal(history[0]?.content, "请读图");
  assert.deepEqual(history[0]?.attachments, [{
    id: "artifact-1",
    originalName: "screen.png",
    mimeType: "image/png",
    sizeBytes: 123,
  }]);
});

test("restores a legacy archived image by the upload id embedded in the media note", () => {
  const history = attachConsumedArtifactsToHistory([
    {
      id: "message-old",
      role: "user",
      content: "图片里是什么？\n\n[media attached: /home/runner/.uploads/upload-old-pasted.png]",
      createdAt: "2026-09-04T00:00:00.000Z",
      runId: "legacy-run",
    },
  ], [{
    id: "artifact-old",
    kind: "consumed_upload",
    sessionId: "session-old",
    sessionKey: "course:os:user:user-old",
    sourceUploadId: "upload-old",
    originalName: "pasted.png",
    storedName: "artifact-old-pasted.png",
    artifactPath: "/archive/artifact-old-pasted.png",
    mimeType: "image/png",
    sizeBytes: 456,
    sha256: "def",
    createdAt: "2026-09-04T00:00:00.000Z",
  } satisfies ConsumedArtifactRecord]);

  assert.equal(history[0]?.content, "图片里是什么？");
  assert.equal(history[0]?.attachments?.[0]?.id, "artifact-old");
});

test("retains only the active and latest archived chat session", async () => {
  const home = await fs.mkdtemp(path.join(config.WORKSPACE_ROOT, "chat-retention-"));
  const workspacePath = path.join(home, "project");
  await fs.mkdir(workspacePath);
  const owner = { userId: "student-retention", workspaceId: "workspace-retention" };
  const resetWorkspace = async () => undefined;

  try {
    const oldest = await ensureActiveChatSession(workspacePath, workspacePath, undefined, owner);
    const latestArchived = await createNewChatSession({
      workspacePath,
      cwd: workspacePath,
      reason: "user_slash_new",
      confirmed: true,
      resetWorkspace,
      owner,
    });
    const active = await createNewChatSession({
      workspacePath,
      cwd: workspacePath,
      reason: "user_slash_new",
      confirmed: true,
      resetWorkspace,
      owner,
    });

    const result = await retainChatSessions(
      workspacePath,
      [active.sessionId, latestArchived.sessionId],
      owner,
    );
    const listing = await listChatSessions(workspacePath, owner);

    assert.deepEqual(result.removedSessionIds, [oldest.sessionId]);
    assert.deepEqual(
      new Set(listing.sessions.map((session) => session.sessionId)),
      new Set([active.sessionId, latestArchived.sessionId]),
    );
    await assert.rejects(fs.access(sessionTranscriptPath(workspacePath, oldest.sessionId)));
    await fs.access(sessionTranscriptPath(workspacePath, latestArchived.sessionId));
    await fs.access(sessionTranscriptPath(workspacePath, active.sessionId));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("persists and isolates conversations with different logical course keys", async () => {
  const home = await fs.mkdtemp(path.join(config.WORKSPACE_ROOT, "teacher-review-chat-"));
  const workspacePath = path.join(home, "project");
  const auditPath = path.join(home, "audit");
  await fs.mkdir(workspacePath);
  await fs.mkdir(auditPath);
  const firstOwner = {
    courseId: "courseworks-review:student-a",
    userId: "teacher-1",
    workspaceId: "teacher-workspace-1",
  };
  const secondOwner = {
    courseId: "courseworks-review:student-b",
    userId: "teacher-1",
    workspaceId: "teacher-workspace-1",
  };

  try {
    const firstSession = await ensureActiveChatSession(workspacePath, auditPath, "检查进度", firstOwner);
    await appendTurnRecord(workspacePath, firstSession, { role: "user", content: "检查进度" });
    await appendTurnRecord(workspacePath, firstSession, { role: "assistant", content: "已完成主要功能。" });

    const restored = await getActiveChatSessionSnapshot(workspacePath, auditPath, firstOwner);
    const stored = JSON.parse(await fs.readFile(sessionStorePath(workspacePath), "utf8")) as {
      activeSessionKeys: Record<string, string | null>;
    };
    stored.activeSessionKeys["course:courseworks-review:student-b:user:teacher-1"] = firstSession.sessionId;
    await fs.writeFile(sessionStorePath(workspacePath), JSON.stringify(stored));
    const isolated = await getActiveChatSessionSnapshot(workspacePath, auditPath, secondOwner);

    assert.equal(restored.currentSessionId, firstSession.sessionId);
    assert.deepEqual(restored.history.map((message) => [message.role, message.content]), [
      ["user", "检查进度"],
      ["assistant", "已完成主要功能。"],
    ]);
    assert.notEqual(isolated.currentSessionId, firstSession.sessionId);
    assert.deepEqual(isolated.history, []);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
