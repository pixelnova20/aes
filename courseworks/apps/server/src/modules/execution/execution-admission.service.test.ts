import assert from "node:assert/strict";
import test from "node:test";

import { executionAdmissionTestSupport, tryAcquireExecutionAdmission } from "./execution-admission.service.js";
import { getContainerRunProfile } from "./container-run-profile.js";

test("admission enforces the per-workspace heavy and global QEMU limits", () => {
  executionAdmissionTestSupport.reset();
  const qemu = getContainerRunProfile("qemu");
  const first = tryAcquireExecutionAdmission({ profiles: [qemu], workspaceId: "workspace-a", interactive: true });
  assert.ok(first);
  assert.equal(tryAcquireExecutionAdmission({ profiles: [qemu], workspaceId: "workspace-a", interactive: true }), null);
  const second = tryAcquireExecutionAdmission({ profiles: [qemu], workspaceId: "workspace-b", interactive: true });
  assert.ok(second);
  assert.equal(tryAcquireExecutionAdmission({ profiles: [qemu], workspaceId: "workspace-c", interactive: true }), null);
  first.release();
  second.release();
  assert.equal(executionAdmissionTestSupport.snapshot().active, 0);
});
