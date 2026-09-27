import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { config } from "../../config/index.js";
import { evaluationArtifactsRoot } from "./artifact-paths.js";
import { getConsumedArtifact, retainArtifactsForSessions } from "./artifact-store.js";
import {
  archiveWorkspaceUploads,
  consumeStagedUploads,
  listStagedUploads,
  removeStagedUpload,
  stageUploads,
} from "./upload-store.js";

test("retains uploads during the active session and moves them only when archived", async () => {
  const home = await fs.mkdtemp(path.join(config.WORKSPACE_ROOT, "attachment-lifecycle-"));
  const workspacePath = path.join(home, "project");
  await fs.mkdir(workspacePath);

  try {
    const [submitted, removed] = await stageUploads({
      workspacePath,
      userId: "student-test",
      courseId: "os",
      workspaceId: "workspace-test",
      files: [
        { name: "screen.png", mimeType: "image/png", contentBase64: "iVBORw0KGgoAAAANSUhEUg==" },
        { name: "notes.txt", mimeType: "text/plain", contentBase64: Buffer.from("draft").toString("base64") },
      ],
    });
    const consumed = await consumeStagedUploads({
      workspacePath,
      session: { sessionId: "session-test", sessionKey: "student-test" },
      runId: "run-test",
      uploadIds: [submitted.id],
    });

    assert.equal(consumed.artifacts.length, 1);
    assert.equal(consumed.artifacts[0].artifactPath, submitted.absolutePath);
    await fs.access(submitted.absolutePath);
    await assert.rejects(fs.access(path.join(evaluationArtifactsRoot(workspacePath), submitted.storedName)));

    assert.equal(await removeStagedUpload(workspacePath, removed.id), true);
    await fs.access(removed.absolutePath);

    const result = await archiveWorkspaceUploads(workspacePath, "session-test");
    assert.equal(result.moved, 2);
    assert.deepEqual(await listStagedUploads(workspacePath), []);
    await assert.rejects(fs.access(submitted.absolutePath));
    await assert.rejects(fs.access(removed.absolutePath));
    await fs.access(path.join(evaluationArtifactsRoot(workspacePath), submitted.storedName));
    await fs.access(path.join(evaluationArtifactsRoot(workspacePath), removed.storedName));

    const archivedArtifact = await getConsumedArtifact(workspacePath, consumed.artifacts[0].id);
    assert.equal(archivedArtifact?.artifactPath, path.join(evaluationArtifactsRoot(workspacePath), submitted.storedName));
    const legacyOrphanPath = path.join(evaluationArtifactsRoot(workspacePath), "legacy-unindexed-upload.txt");
    await fs.writeFile(legacyOrphanPath, "legacy");

    const retention = await retainArtifactsForSessions(workspacePath, ["session-current"]);
    assert.equal(retention.removedFiles, 3);
    await assert.rejects(fs.access(path.join(evaluationArtifactsRoot(workspacePath), submitted.storedName)));
    await assert.rejects(fs.access(path.join(evaluationArtifactsRoot(workspacePath), removed.storedName)));
    await assert.rejects(fs.access(legacyOrphanPath));
    assert.equal(await getConsumedArtifact(workspacePath, consumed.artifacts[0].id), null);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
