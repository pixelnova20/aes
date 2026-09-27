import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { config } from "../../config/index.js";
import {
  assertWorkspaceWriteAllowed,
  DISK_QUOTA_ERROR_MESSAGE,
  getWorkspaceDiskQuota,
  workspaceDiskQuotaTestSupport,
} from "./workspace-disk-quota.service.js";

test("disk usage measurement does not follow symlinks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "courseworks-quota-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "courseworks-quota-outside-"));
  await fs.writeFile(path.join(outside, "large.bin"), Buffer.alloc(4096));
  await fs.writeFile(path.join(root, "small.txt"), "small");
  await fs.symlink(outside, path.join(root, "linked-outside"));
  const usage = await workspaceDiskQuotaTestSupport.measure(root);
  assert.ok(usage < 4096 + 1024);
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

test("workspace quota includes files beside the project directory", async () => {
  const home = await fs.mkdtemp(path.join(config.WORKSPACE_ROOT, "courseworks-quota-home-"));
  const workspacePath = path.join(home, "project");
  await fs.mkdir(workspacePath);
  await fs.mkdir(path.join(home, ".uploads"));
  await fs.writeFile(path.join(home, ".uploads", "attachment.bin"), Buffer.alloc(8192));

  try {
    const quota = await getWorkspaceDiskQuota(workspacePath);
    assert.ok(quota.usageBytes >= 8192);
    assert.equal(quota.hardLimitBytes, 250 * 1024 * 1024);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("workspace quota reports the student-facing storage error at 250 MiB", async () => {
  const home = await fs.mkdtemp(path.join(config.WORKSPACE_ROOT, "courseworks-quota-limit-"));
  const workspacePath = path.join(home, "project");
  await fs.mkdir(workspacePath);
  const largeFile = path.join(workspacePath, "large.bin");
  await fs.writeFile(largeFile, "");
  await fs.truncate(largeFile, 250 * 1024 * 1024);

  try {
    await assert.rejects(
      assertWorkspaceWriteAllowed(workspacePath, 1),
      (error: Error) => error.message === DISK_QUOTA_ERROR_MESSAGE,
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
