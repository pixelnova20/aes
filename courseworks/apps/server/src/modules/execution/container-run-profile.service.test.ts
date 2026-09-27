import assert from "node:assert/strict";
import test from "node:test";

import {
  containerRunProfileTestSupport,
  getContainerRunProfile,
  managedContainerLabelArgs,
  parseMemoryBytes,
  resourceArgs,
} from "./container-run-profile.js";

test("container profiles include the same memory swap limit and file descriptor limit", () => {
  const profile = getContainerRunProfile("qemu");
  const args = resourceArgs(profile);
  assert.deepEqual(args, ["--cpus", "1", "--memory", "1g", "--memory-swap", "1g", "--pids-limit", "192", "--ulimit", "nofile=1024:1024"]);
});

test("managed labels identify only Courseworks containers", () => {
  assert.deepEqual(managedContainerLabelArgs({ purpose: "build", workspaceId: "workspace/1", runId: "run-1" }), [
    "--label", "courseworks.managed=true",
    "--label", "courseworks.purpose=build",
    "--label", "courseworks.workspace=workspace_1",
    "--label", "courseworks.run=run-1",
  ]);
});

test("Docker memory values are converted consistently", () => {
  assert.equal(parseMemoryBytes("768m"), 768 * 1024 ** 2);
  assert.equal(parseMemoryBytes("1g"), 1024 ** 3);
  assert.equal(containerRunProfileTestSupport.parseMemoryBytes("128m"), 128 * 1024 ** 2);
});
