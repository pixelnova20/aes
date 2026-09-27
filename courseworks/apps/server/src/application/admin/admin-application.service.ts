/**
 * 文件作用：编排后端“平台管理”应用编排层用例及其跨模块调用。
 * 模块位置：`apps/server/src/application/admin/admin-application.service.ts`，属于后端“平台管理”应用编排层。
 * 重要函数：`getAdminSummary()` 负责获取`admin` 摘要；`listAdminUsers()` 负责列出`admin` 用户列表；`updateManagedUserRole()` 负责更新`managed` 用户 角色；`listInviteCodes()` 负责列出邀请码 `codes`；`createInviteCode()` 负责创建邀请码 代码；`updateInviteCodeStatus()` 负责更新邀请码 代码 状态；`deleteInviteCode()` 负责删除邀请码 代码；`listAdminWorkspaces()` 负责列出`admin` 工作区列表。
 */
import { UserRole } from "@prisma/client";

import {
  syncHomeworksInviteCode,
  syncHomeworksInviteCodeStatus,
  syncHomeworksUser,
  archiveAndDeleteManagedUsers,
} from "../../infrastructure/management.js";
import { prisma } from "../../infrastructure/prisma/client.js";

/**
 * 功能：获取`admin` 摘要。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/admin.router.ts 顶层流程` 调用；内部调用 `all()`、`count()`。
 */
export async function getAdminSummary() {
  const [users, inviteCodes, workspaces] = await Promise.all([
    prisma.user.count(),
    prisma.inviteCode.count(),
    prisma.workspace.count(),
  ]);
  return { users, inviteCodes, workspaces };
}

/**
 * 功能：列出`admin` 用户列表。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/admin.router.ts 顶层流程` 调用；内部调用 `findMany()`。
 */
export async function listAdminUsers() {
  const users = await prisma.user.findMany({
    include: {
      inviteCode: true,
      workspace: true,
      agentRuns: {
        orderBy: { updatedAt: "desc" },
        take: 1,
        include: {
          buildRuns: { orderBy: { createdAt: "desc" }, take: 1 },
          qemuSmokeRuns: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  const configuredEmails = new Set((await prisma.aiProviderSelection.findMany({
    where: { ownerEmail: { in: users.map((user) => user.email.trim().toLowerCase()) } },
    select: { ownerEmail: true },
  })).map((item) => item.ownerEmail));
  return users.map((user) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    studentNo: user.studentNo,
    courseName: user.courseName,
    isActive: user.isActive,
    className: user.inviteCode?.className ?? null,
    inviteCode: user.inviteCode?.code ?? null,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    workspaceStatus: user.workspace?.status ?? "not_created",
    aiProviderConfigured: configuredEmails.has(user.email.trim().toLowerCase()),
    osType: user.workspace?.osType ?? null,
    targetArch: user.workspace?.targetArch ?? null,
    lastAgentStatus: user.agentRuns[0]?.status ?? null,
    lastBuildStatus: user.agentRuns[0]?.buildRuns[0]?.status ?? null,
    lastQemuSmokeStatus: user.agentRuns[0]?.qemuSmokeRuns[0]?.status ?? null,
  }));
}

/**
 * 功能：更新`managed` 用户 角色。
 * 输入：`userId`（string）提供用户 id。 `role`（"teacher" | "student"）提供角色。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/transport/http/routes/admin.router.ts 顶层流程` 调用；内部调用 `update()`。
 */
export async function updateManagedUserRole(userId: string, role: "teacher" | "ta" | "student") {
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) throw new Error("用户不存在。");
  if (target.role === UserRole.super_admin) {
    throw new Error("不能修改内置超级管理员账号。");
  }
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { role },
    include: { inviteCode: true },
  });
  await syncHomeworksUser({
    externalId: updated.id,
    email: updated.email,
    name: updated.name,
    role: updated.role,
    studentNo: updated.studentNo,
    courseName: updated.courseName,
    className: updated.inviteCode?.className ?? null,
    inviteCode: updated.inviteCode?.code ?? null,
    enabled: updated.isActive,
  });
  return { id: updated.id, role: updated.role };
}

/** Archive and delete one managed account from Courseworks and Homeworks. */
export async function deleteManagedUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { inviteCode: true },
  });
  if (!user) throw new Error("用户不存在。");
  if (user.role === UserRole.super_admin) {
    throw new Error("不能删除超级管理员账号。");
  }
  if (user.role === UserRole.teacher && user.inviteCode?.level === "level_1") {
    const invitations = await prisma.inviteCode.findMany({
      where: {
        OR: [
          { id: user.inviteCode.id },
          { parentInviteCodeId: user.inviteCode.id },
        ],
      },
      include: { users: { select: { id: true, email: true, role: true } } },
    });
    const relatedUsers = new Map<string, { id: string; email: string; role: UserRole }>([
      [user.id, { id: user.id, email: user.email, role: user.role }],
    ]);
    for (const invitation of invitations) {
      for (const member of invitation.users) relatedUsers.set(member.id, member);
    }
    return archiveAndDeleteManagedUsers({
      users: [...relatedUsers.values()],
      reason: { kind: "user", userId: user.id },
      inviteCodeIds: invitations.map((item) => item.id),
      inviteCodes: invitations.map((item) => item.code),
    });
  }
  return archiveAndDeleteManagedUsers({
    users: [user],
    reason: { kind: "user", userId: user.id },
  });
}

/**
 * 功能：列出邀请码 `codes`。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/admin.router.ts 顶层流程` 调用；内部调用 `findMany()`。
 */
export async function listInviteCodes() {
  const inviteCodes = await prisma.inviteCode.findMany({
    include: {
      teacher: true,
      parentInviteCode: { select: { code: true } },
      childInviteCodes: {
        include: { users: { select: { id: true } } },
        orderBy: { code: "asc" },
      },
      users: { select: { id: true } },
      uses: { include: { user: true }, orderBy: { usedAt: "asc" } },
    },
    orderBy: { createdAt: "desc" },
  });
  return inviteCodes.map((inviteCode) => ({
    id: inviteCode.id,
    code: inviteCode.code,
    description: inviteCode.description,
    level: inviteCode.level,
    parentCode: inviteCode.parentInviteCode?.code ?? null,
    courseName: inviteCode.courseName,
    className: inviteCode.className,
    teacher: inviteCode.teacher?.email ?? null,
    usedCount: inviteCode.usedCount,
    maxUses: inviteCode.maxUses,
    expiresAt: inviteCode.expiresAt,
    isActive: inviteCode.isActive,
    relatedUserCount: new Set([
      ...inviteCode.users.map((user) => user.id),
      ...inviteCode.uses.map((use) => use.user.id),
      ...(inviteCode.level === "level_1" && inviteCode.teacher ? [inviteCode.teacher.id] : []),
      ...inviteCode.childInviteCodes.flatMap((child) => child.users.map((user) => user.id)),
    ]).size,
    usageRecords: inviteCode.uses.map((use) => ({
      email: use.user.email,
      role: use.user.role,
      usedAt: use.usedAt,
    })),
  }));
}

/**
 * 功能：创建邀请码 代码。
 * 输入：`input`（{ code: string; description?: string; className: string; maxUses: number; expiresAt?: string; }）提供当前操作所需的结构化输入。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/admin.router.ts 顶层流程` 调用；内部调用 `create()`。
 */
export async function createInviteCode(input: {
  code: string;
  description?: string;
}) {
  const inviteCode = await prisma.inviteCode.create({
    data: {
      code: input.code.trim(),
      description: input.description,
      level: "level_1",
      courseName: null,
      className: null,
      maxUses: 1,
      expiresAt: null,
    },
  });
  await syncHomeworksInviteCode({
    code: inviteCode.code,
    level: inviteCode.level,
    courseName: inviteCode.courseName,
    className: inviteCode.className,
    maxUses: inviteCode.maxUses,
    usedCount: inviteCode.usedCount,
    isActive: inviteCode.isActive,
    expiresAt: inviteCode.expiresAt,
  });
  return inviteCode;
}

/**
 * 功能：更新邀请码 代码 状态。
 * 输入：`inviteCodeId`（string）提供邀请码 代码 id。 `isActive`（boolean）提供is active。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/transport/http/routes/admin.router.ts 顶层流程` 调用；内部调用 `update()`。
 */
export async function updateInviteCodeStatus(inviteCodeId: string, isActive: boolean) {
  const inviteCode = await prisma.inviteCode.update({
    where: { id: inviteCodeId },
    data: { isActive },
  });
  await syncHomeworksInviteCodeStatus(inviteCode.code, inviteCode.isActive);
  if (inviteCode.level === "level_1") {
    const children = await prisma.inviteCode.findMany({
      where: { parentInviteCodeId: inviteCode.id },
      select: { id: true, code: true },
    });
    await prisma.inviteCode.updateMany({
      where: { parentInviteCodeId: inviteCode.id },
      data: { isActive },
    });
    await Promise.all(children.map((child) => syncHomeworksInviteCodeStatus(child.code, isActive)));
  }
  return { id: inviteCode.id, isActive: inviteCode.isActive };
}

/**
 * 功能：删除邀请码 代码。
 * 输入：`inviteCodeId`（string）提供邀请码 代码 id。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/transport/http/routes/admin.router.ts 顶层流程`、`apps/web/src/features/admin/AdminPage.tsx:AdminPage()` 调用；内部调用 `findUnique()`、`delete()`。
 */
export async function deleteInviteCode(inviteCodeId: string) {
  const inviteCode = await prisma.inviteCode.findUnique({
    where: { id: inviteCodeId },
    include: {
      teacher: { select: { id: true, email: true, role: true } },
      uses: { include: { user: { select: { id: true, email: true, role: true } } } },
      users: { select: { id: true, email: true, role: true } },
      childInviteCodes: {
        include: {
          uses: { include: { user: { select: { id: true, email: true, role: true } } } },
          users: { select: { id: true, email: true, role: true } },
        },
      },
    },
  });
  if (!inviteCode) throw new Error("邀请码不存在。");

  const relatedUsers = new Map<string, { id: string; email: string; role: UserRole }>();
  for (const user of inviteCode.users) relatedUsers.set(user.id, user);
  for (const use of inviteCode.uses) relatedUsers.set(use.user.id, use.user);
  if (inviteCode.level === "level_1" && inviteCode.teacher) {
    relatedUsers.set(inviteCode.teacher.id, inviteCode.teacher);
  }
  for (const child of inviteCode.childInviteCodes) {
    for (const user of child.users) relatedUsers.set(user.id, user);
    for (const use of child.uses) relatedUsers.set(use.user.id, use.user);
  }
  if ([...relatedUsers.values()].some((user) => user.role === UserRole.super_admin)) {
    throw new Error("不能删除与超级管理员关联的邀请码。");
  }

  const deletedInvites = [inviteCode, ...inviteCode.childInviteCodes];
  const result = await archiveAndDeleteManagedUsers({
    users: [...relatedUsers.values()],
    reason: { kind: "invite_code", inviteCodeId, code: inviteCode.code },
    inviteCodeIds: deletedInvites.map((item) => item.id),
    inviteCodes: deletedInvites.map((item) => item.code),
  });
  return { id: inviteCodeId, ...result };
}

/**
 * 功能：列出`admin` 工作区列表。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/admin.router.ts 顶层流程` 调用；内部调用 `findMany()`。
 */
export async function listAdminWorkspaces() {
  const workspaces = await prisma.workspace.findMany({
    include: {
      user: true,
      agentRuns: {
        orderBy: { updatedAt: "desc" },
        take: 1,
        include: {
          buildRuns: { orderBy: { createdAt: "desc" }, take: 1 },
          qemuSmokeRuns: { orderBy: { createdAt: "desc" }, take: 1 },
        },
      },
    },
    orderBy: { updatedAt: "desc" },
  });
  return workspaces.map((workspace) => ({
    id: workspace.id,
    email: workspace.user.email,
    role: workspace.user.role,
    workspaceStatus: workspace.status,
    osType: workspace.osType,
    targetArch: workspace.targetArch,
    targetPlatform: workspace.targetPlatform,
    path: workspace.path,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
    lastAgentStatus: workspace.agentRuns[0]?.status ?? null,
    lastBuildStatus: workspace.agentRuns[0]?.buildRuns[0]?.status ?? null,
    lastQemuSmokeStatus: workspace.agentRuns[0]?.qemuSmokeRuns[0]?.status ?? null,
  }));
}

/**
 * 功能：列出`administrators`。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/admin.router.ts 顶层流程` 调用；内部调用 `findMany()`。
 */
/**
 * 功能：处理`visible` 运行 `filter`。
 * 输入：`canSeeSuperAdmin`（boolean）提供can see super admin。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/admin/admin-application.service.ts:listAdminAgentRuns()`、`apps/server/src/application/admin/admin-application.service.ts:getAdminAgentRun()`、`apps/server/src/application/admin/admin-application.service.ts:getAdminAgentRunTrace()` 调用。
 */
function visibleRunFilter(canSeeSuperAdmin: boolean) {
  return canSeeSuperAdmin ? {} : { user: { role: { not: UserRole.super_admin } } };
}

/**
 * 功能：列出`admin` Agent 运行列表。
 * 输入：`canSeeSuperAdmin`（boolean）提供can see super admin。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/admin.router.ts 顶层流程` 调用；内部调用 `findMany()`、`visibleRunFilter()`。
 */
export async function listAdminAgentRuns(canSeeSuperAdmin: boolean) {
  const runs = await prisma.agentRun.findMany({
    where: visibleRunFilter(canSeeSuperAdmin),
    include: {
      user: { include: { inviteCode: true } },
      workspace: true,
      patchPlans: { orderBy: { createdAt: "desc" }, take: 1 },
      buildRuns: { orderBy: { createdAt: "desc" }, take: 1 },
      qemuSmokeRuns: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { updatedAt: "desc" },
    take: 100,
  });
  return runs.map((run) => ({
    id: run.id,
    email: run.user.email,
    role: run.user.role,
    className: run.user.inviteCode?.className ?? null,
    inviteCode: run.user.inviteCode?.code ?? null,
    workspaceStatus: run.workspace.status,
    prompt: run.prompt.slice(0, 240),
    status: run.status,
    currentStep: run.currentStep,
    taskSummary: run.taskSummary,
    patchPlanStatus: run.patchPlans[0]?.status ?? null,
    lastBuildStatus: run.buildRuns[0]?.status ?? null,
    lastBuildAt: run.buildRuns[0]?.createdAt ?? null,
    lastQemuSmokeStatus: run.qemuSmokeRuns[0]?.status ?? null,
    lastQemuSmokeAt: run.qemuSmokeRuns[0]?.createdAt ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  }));
}

/**
 * 功能：获取`admin` Agent 运行。
 * 输入：`runId`（string）提供运行 id。 `canSeeSuperAdmin`（boolean）提供can see super admin。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/admin.router.ts 顶层流程` 调用；内部调用 `findFirst()`、`visibleRunFilter()`。
 */
export function getAdminAgentRun(runId: string, canSeeSuperAdmin: boolean) {
  return prisma.agentRun.findFirst({
    where: { id: runId, ...visibleRunFilter(canSeeSuperAdmin) },
    include: {
      user: { include: { inviteCode: true } },
      workspace: true,
      traceEvents: { orderBy: { createdAt: "asc" } },
      patchPlans: { orderBy: { createdAt: "desc" }, take: 1 },
      checkpoints: { orderBy: { createdAt: "desc" } },
      buildRuns: { orderBy: { createdAt: "desc" }, take: 1 },
      qemuSmokeRuns: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
}

/**
 * 功能：获取`admin` Agent 运行 `trace`。
 * 输入：`runId`（string）提供运行 id。 `canSeeSuperAdmin`（boolean）提供can see super admin。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/admin.router.ts 顶层流程` 调用；内部调用 `findFirst()`、`visibleRunFilter()`、`findMany()`。
 */
export async function getAdminAgentRunTrace(runId: string, canSeeSuperAdmin: boolean) {
  const run = await prisma.agentRun.findFirst({
    where: { id: runId, ...visibleRunFilter(canSeeSuperAdmin) },
    select: { id: true },
  });
  if (!run) return null;
  return prisma.agentTraceEvent.findMany({
    where: { agentRunId: run.id },
    orderBy: { createdAt: "asc" },
  });
}
