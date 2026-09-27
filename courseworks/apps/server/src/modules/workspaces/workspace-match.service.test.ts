import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { syncWorkspaceMatchFile } from "./workspace-match.service.js";

test("syncWorkspaceMatchFile writes existing database workspaces and removes stale entries", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "courseworks-workspace-match-"));
  const existingWorkspaceUuid = "11111111-1111-4111-8111-111111111111";
  const missingWorkspaceUuid = "22222222-2222-4222-8222-222222222222";
  await fs.mkdir(path.join(workspaceRoot, existingWorkspaceUuid));
  await fs.mkdir(path.join(workspaceRoot, existingWorkspaceUuid, ".local", "state", "ai-os-builder"), { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "match.txt"), "stale@example.com\tstale\n", "utf8");

  const client = {
    workspace: {
      findMany: async () => [
        { workspaceUuid: existingWorkspaceUuid, user: { email: "student@example.com" } },
        { workspaceUuid: missingWorkspaceUuid, user: { email: "missing@example.com" } },
      ],
    },
  } as unknown as NonNullable<Parameters<typeof syncWorkspaceMatchFile>[0]>["client"];

  await syncWorkspaceMatchFile({ workspaceRoot, client });

  assert.equal(
    await fs.readFile(path.join(workspaceRoot, "match.txt"), "utf8"),
    `${"student@example.com"}\t${existingWorkspaceUuid}\tlegacy-ai-os-builder\n`,
  );
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});
