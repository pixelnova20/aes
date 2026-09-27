/**
 * Creates recovery bundles and removes non-administrator accounts from both systems.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { UserRole } from "./role-policy.js";

export type ManagedUserRole = UserRole;
export type ArchiveDependencies = {
  prisma: any;
  archiveRoot: string;
  workspaceRoot: string;
  archiveAndDeleteHomeworksUsers: (input: {
    externalIds: string[];
    archiveDirectory: string;
    inviteCodes?: string[];
  }) => Promise<void>;
  syncHomeworksInviteCodeUsage: (code: string, usedCount: number) => Promise<void>;
  resetWorkspaceLabSessions: (workspaceId: string) => void;
  syncWorkspaceMatchFile: () => Promise<void>;
};

let configuredDependencies: ArchiveDependencies | null = null;

export function configureAccountArchiveService(dependencies: ArchiveDependencies) {
  configuredDependencies = dependencies;
}

function dependencies() {
  if (!configuredDependencies) {
    throw new Error("Account archive service has not been configured.");
  }
  return configuredDependencies;
}

type DeleteReason =
  | { kind: "user"; userId: string }
  | { kind: "invite_code"; inviteCodeId: string; code: string };

export function assertAccountsCanBeDeleted(users: Array<{ role: ManagedUserRole }>) {
  if (users.some((user) => user.role === "super_admin")) {
    throw new Error("Super administrator accounts cannot be deleted.");
  }
}

function archiveSlug(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "accounts";
}

function json(value: unknown) {
  return `${JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2)}\n`;
}

async function writePrivateJson(filePath: string, value: unknown) {
  await fs.writeFile(filePath, json(value), { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600);
}

async function createArchiveDirectory(label: string) {
  const { archiveRoot } = dependencies();
  await fs.mkdir(archiveRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(archiveRoot, 0o700);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = path.join(
    archiveRoot,
    `${timestamp}-${archiveSlug(label)}-${randomUUID().slice(0, 8)}`,
  );
  await fs.mkdir(directory, { mode: 0o700 });
  return directory;
}

async function collectCourseworksSnapshot(userIds: string[], deletedInviteCodeIds: string[] = []) {
  const { prisma } = dependencies();
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, orderBy: { id: "asc" } });
  const ownerEmails = [...new Set(users.map((user: { email: string }) => user.email.trim().toLowerCase()))];
  const workspaces = await prisma.workspace.findMany({ where: { userId: { in: userIds } }, orderBy: { id: "asc" } });
  const workspaceIds = workspaces.map((item) => item.id);
  const agentRuns = await prisma.agentRun.findMany({
    where: { OR: [{ userId: { in: userIds } }, { workspaceId: { in: workspaceIds } }] },
    orderBy: { id: "asc" },
  });
  const agentRunIds = agentRuns.map((item) => item.id);
  const courseTaskSessions = await prisma.courseTaskSession.findMany({
    where: { OR: [{ userId: { in: userIds } }, { workspaceId: { in: workspaceIds } }] },
    orderBy: { id: "asc" },
  });
  const courseTaskSessionIds = courseTaskSessions.map((item) => item.id);
  const courseSubtasks = await prisma.courseSubtask.findMany({
    where: { courseTaskSessionId: { in: courseTaskSessionIds } },
    orderBy: { id: "asc" },
  });
  const courseSubtaskIds = courseSubtasks.map((item) => item.id);

  const [
    inviteCodeUses,
    inviteCodes,
    aiProviderSettings,
    aiProviderProfiles,
    aiProviderSelections,
    evaluationCourseContexts,
    workspaceActivityEvents,
    courseSubtaskFiles,
    agentTraceEvents,
    agentPatchPlans,
    checkpoints,
    buildRuns,
    qemuSmokeRuns,
  ] = await Promise.all([
    prisma.inviteCodeUse.findMany({ where: { userId: { in: userIds } }, orderBy: { id: "asc" } }),
    prisma.inviteCode.findMany({
      where: {
        OR: [
          { teacherUserId: { in: userIds } },
          ...(deletedInviteCodeIds.length ? [{ id: { in: deletedInviteCodeIds } }] : []),
        ],
      },
      orderBy: { id: "asc" },
    }),
    prisma.aiProviderSetting.findMany({ where: { userId: { in: userIds } }, orderBy: { id: "asc" } }),
    prisma.aiProviderProfile.findMany({ where: { ownerEmail: { in: ownerEmails } }, orderBy: { id: "asc" } }),
    prisma.aiProviderSelection.findMany({ where: { ownerEmail: { in: ownerEmails } }, orderBy: { ownerEmail: "asc" } }),
    prisma.evaluationCourseContext.findMany({ where: { workspaceId: { in: workspaceIds } }, orderBy: { id: "asc" } }),
    prisma.workspaceActivityEvent.findMany({
      where: {
        OR: [
          { actorUserId: { in: userIds } },
          { workspaceId: { in: workspaceIds } },
          { agentRunId: { in: agentRunIds } },
        ],
      },
      orderBy: { id: "asc" },
    }),
    prisma.courseSubtaskFile.findMany({ where: { courseSubtaskId: { in: courseSubtaskIds } }, orderBy: { id: "asc" } }),
    prisma.agentTraceEvent.findMany({ where: { agentRunId: { in: agentRunIds } }, orderBy: { id: "asc" } }),
    prisma.agentPatchPlan.findMany({ where: { agentRunId: { in: agentRunIds } }, orderBy: { id: "asc" } }),
    prisma.checkpoint.findMany({
      where: { OR: [{ agentRunId: { in: agentRunIds } }, { workspaceId: { in: workspaceIds } }] },
      orderBy: { id: "asc" },
    }),
    prisma.buildRun.findMany({
      where: { OR: [{ agentRunId: { in: agentRunIds } }, { workspaceId: { in: workspaceIds } }] },
      orderBy: { id: "asc" },
    }),
    prisma.qemuSmokeRun.findMany({
      where: { OR: [{ agentRunId: { in: agentRunIds } }, { workspaceId: { in: workspaceIds } }] },
      orderBy: { id: "asc" },
    }),
  ]);

  return {
    users,
    inviteCodeUses,
    inviteCodes,
    aiProviderSettings,
    aiProviderProfiles,
    aiProviderSelections,
    workspaces,
    evaluationCourseContexts,
    workspaceActivityEvents,
    courseTaskSessions,
    courseSubtasks,
    courseSubtaskFiles,
    agentRuns,
    agentTraceEvents,
    agentPatchPlans,
    checkpoints,
    buildRuns,
    qemuSmokeRuns,
  };
}

async function archiveWorkspaces(
  archiveDirectory: string,
  workspaces: Array<{ id: string; workspaceUuid: string; path: string }>,
) {
  const { resetWorkspaceLabSessions, workspaceRoot } = dependencies();
  const inventory: Array<{ workspaceId: string; workspaceUuid: string; archived: boolean }> = [];
  const configuredRoot = path.resolve(workspaceRoot);
  for (const workspace of workspaces) {
    resetWorkspaceLabSessions(workspace.id);
    const source = path.resolve(configuredRoot, workspace.workspaceUuid);
    if (path.dirname(source) !== configuredRoot) {
      throw new Error(`Workspace is outside configured root: ${workspace.workspaceUuid}`);
    }
    const destination = path.join(archiveDirectory, "courseworks-workspaces", workspace.workspaceUuid);
    try {
      const stat = await fs.stat(source);
      if (!stat.isDirectory()) throw new Error("Workspace path is not a directory.");
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.cp(source, destination, { recursive: true, preserveTimestamps: true });
      inventory.push({ workspaceId: workspace.id, workspaceUuid: workspace.workspaceUuid, archived: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      inventory.push({ workspaceId: workspace.id, workspaceUuid: workspace.workspaceUuid, archived: false });
    }
  }
  return inventory;
}

async function deleteCourseworksRecords(userIds: string[], inviteCodeIds: string[] = []) {
  const { prisma } = dependencies();
  return prisma.$transaction(async (transaction) => {
    const deletedUsers = await transaction.user.findMany({
      where: { id: { in: userIds } },
      select: { email: true },
    });
    const ownerEmails = [...new Set(deletedUsers.map((user: { email: string }) => user.email.trim().toLowerCase()))];
    const workspaces = await transaction.workspace.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
    const workspaceIds = workspaces.map((item) => item.id);
    const agentRuns = await transaction.agentRun.findMany({
      where: { OR: [{ userId: { in: userIds } }, { workspaceId: { in: workspaceIds } }] },
      select: { id: true },
    });
    const agentRunIds = agentRuns.map((item) => item.id);
    const taskSessions = await transaction.courseTaskSession.findMany({
      where: { OR: [{ userId: { in: userIds } }, { workspaceId: { in: workspaceIds } }] },
      select: { id: true },
    });
    const taskSessionIds = taskSessions.map((item) => item.id);
    const subtasks = await transaction.courseSubtask.findMany({
      where: { courseTaskSessionId: { in: taskSessionIds } },
      select: { id: true },
    });
    const subtaskIds = subtasks.map((item) => item.id);
    const affectedInviteIds = (await transaction.inviteCodeUse.findMany({
      where: { userId: { in: userIds } },
      select: { inviteCodeId: true },
      distinct: ["inviteCodeId"],
    })).map((item) => item.inviteCodeId).filter((id) => !inviteCodeIds.includes(id));

    await transaction.workspaceActivityEvent.deleteMany({
      where: {
        OR: [
          { actorUserId: { in: userIds } },
          { workspaceId: { in: workspaceIds } },
          { agentRunId: { in: agentRunIds } },
        ],
      },
    });
    await transaction.agentTraceEvent.deleteMany({ where: { agentRunId: { in: agentRunIds } } });
    await transaction.agentPatchPlan.deleteMany({ where: { agentRunId: { in: agentRunIds } } });
    await transaction.checkpoint.deleteMany({
      where: { OR: [{ agentRunId: { in: agentRunIds } }, { workspaceId: { in: workspaceIds } }] },
    });
    await transaction.buildRun.deleteMany({
      where: { OR: [{ agentRunId: { in: agentRunIds } }, { workspaceId: { in: workspaceIds } }] },
    });
    await transaction.qemuSmokeRun.deleteMany({
      where: { OR: [{ agentRunId: { in: agentRunIds } }, { workspaceId: { in: workspaceIds } }] },
    });
    await transaction.agentRun.deleteMany({ where: { id: { in: agentRunIds } } });
    await transaction.courseSubtaskFile.deleteMany({ where: { courseSubtaskId: { in: subtaskIds } } });
    await transaction.courseSubtask.deleteMany({ where: { id: { in: subtaskIds } } });
    await transaction.courseTaskSession.deleteMany({ where: { id: { in: taskSessionIds } } });
    await transaction.evaluationCourseContext.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await transaction.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await transaction.aiProviderSetting.deleteMany({ where: { userId: { in: userIds } } });
    await transaction.inviteCodeUse.deleteMany({ where: { userId: { in: userIds } } });
    await transaction.inviteCode.updateMany({
      where: { teacherUserId: { in: userIds } },
      data: { teacherUserId: null },
    });
    await transaction.user.deleteMany({ where: { id: { in: userIds } } });

    for (const ownerEmail of ownerEmails) {
      const remainingAccountCount = await transaction.user.count({ where: { email: ownerEmail } });
      if (remainingAccountCount === 0) {
        await transaction.aiProviderSelection.deleteMany({ where: { ownerEmail } });
        await transaction.aiProviderProfile.deleteMany({ where: { ownerEmail } });
      }
    }

    if (inviteCodeIds.length) {
      await transaction.inviteCodeUse.deleteMany({ where: { inviteCodeId: { in: inviteCodeIds } } });
      await transaction.inviteCode.updateMany({
        where: { id: { in: inviteCodeIds } },
        data: { parentInviteCodeId: null },
      });
      await transaction.inviteCode.deleteMany({ where: { id: { in: inviteCodeIds } } });
    }

    const remainingInvites: Array<{ code: string; usedCount: number }> = [];
    for (const id of affectedInviteIds) {
      const usedCount = await transaction.inviteCodeUse.count({ where: { inviteCodeId: id } });
      const invite = await transaction.inviteCode.update({ where: { id }, data: { usedCount } });
      remainingInvites.push({ code: invite.code, usedCount });
    }
    return remainingInvites;
  }, { maxWait: 10_000, timeout: 60_000 });
}

export async function archiveAndDeleteManagedUsers(input: {
  users: Array<{ id: string; email: string; role: ManagedUserRole }>;
  reason: DeleteReason;
  inviteCodeId?: string;
  inviteCode?: string;
  inviteCodeIds?: string[];
  inviteCodes?: string[];
}) {
  const {
    archiveAndDeleteHomeworksUsers,
    syncHomeworksInviteCodeUsage,
    syncWorkspaceMatchFile,
    workspaceRoot,
  } = dependencies();
  const inviteCodeIds = input.inviteCodeIds ?? (input.inviteCodeId ? [input.inviteCodeId] : []);
  const inviteCodes = input.inviteCodes ?? (input.inviteCode ? [input.inviteCode] : []);
  if (input.users.length === 0 && inviteCodeIds.length === 0) {
    throw new Error("No accounts were selected for deletion.");
  }
  assertAccountsCanBeDeleted(input.users);

  const label = input.reason.kind === "invite_code"
    ? `invite-${input.reason.code}`
    : `user-${input.users[0]?.email ?? input.reason.userId}`;
  const archiveDirectory = await createArchiveDirectory(label);
  const userIds = input.users.map((user) => user.id);
  const snapshot = await collectCourseworksSnapshot(userIds, inviteCodeIds);
  const workspaceInventory = await archiveWorkspaces(archiveDirectory, snapshot.workspaces);
  await writePrivateJson(path.join(archiveDirectory, "courseworks.json"), snapshot);
  await writePrivateJson(path.join(archiveDirectory, "manifest.json"), {
    formatVersion: 1,
    status: "archived",
    archivedAt: new Date().toISOString(),
    reason: input.reason,
    users: input.users.map(({ id, email, role }) => ({ id, email, role })),
    workspaceInventory,
  });

  await archiveAndDeleteHomeworksUsers({
    externalIds: userIds,
    archiveDirectory,
    inviteCodes,
  });
  const remainingInvites = await deleteCourseworksRecords(userIds, inviteCodeIds);

  for (const workspace of snapshot.workspaces) {
    await fs.rm(path.resolve(workspaceRoot, workspace.workspaceUuid), { recursive: true, force: true });
  }
  await syncWorkspaceMatchFile();
  for (const invite of remainingInvites) {
    await syncHomeworksInviteCodeUsage(invite.code, invite.usedCount);
  }
  await writePrivateJson(path.join(archiveDirectory, "manifest.json"), {
    formatVersion: 1,
    status: "deleted",
    archivedAt: new Date().toISOString(),
    deletedAt: new Date().toISOString(),
    reason: input.reason,
    users: input.users.map(({ id, email, role }) => ({ id, email, role })),
    workspaceInventory,
  });

  return {
    deleted: true,
    deletedUsers: input.users.length,
    archiveDirectory,
  };
}
