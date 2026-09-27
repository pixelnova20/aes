import { UserRole } from "@prisma/client";

import {
  archiveAndDeleteManagedUsers,
  syncHomeworksInviteCode,
  syncHomeworksUser,
} from "../../infrastructure/management.js";
import { prisma } from "../../infrastructure/prisma/client.js";
import { createAccountSession } from "../identity/account-application.service.js";

async function getAccessibleClass(actorUserId: string, classInviteId: string) {
  const actor = await prisma.user.findUnique({ where: { id: actorUserId } });
  if (!actor) throw new Error("用户不存在。");
  const classInvite = await prisma.inviteCode.findUnique({
    where: { id: classInviteId },
    include: { parentInviteCode: true },
  });
  if (!classInvite || classInvite.level !== "level_2") throw new Error("班级不存在。");
  const allowed = actor.role === UserRole.teacher
    ? classInvite.teacherUserId === actor.id
    : actor.role === UserRole.ta && actor.inviteCodeId === classInvite.id;
  if (!allowed) throw new Error("无权访问该班级。");
  return { actor, classInvite };
}

export async function listTeacherClasses(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error("用户不存在。");
  const classes = await prisma.inviteCode.findMany({
    where: user.role === UserRole.teacher
      ? { level: "level_2", teacherUserId: user.id }
      : { level: "level_2", id: user.inviteCodeId ?? "__none__" },
    include: {
      _count: { select: { users: true } },
      teacher: { select: { email: true, name: true } },
    },
    orderBy: { code: "asc" },
  });
  return classes.map((item) => ({
    id: item.id,
    code: item.code,
    courseName: item.courseName,
    className: item.className,
    capacity: item.maxUses,
    memberCount: item._count.users,
    isActive: item.isActive,
    isCurrent: item.id === user.currentClassInviteId,
    teacher: item.teacher,
  }));
}

export async function createTeacherClass(teacherUserId: string, input: {
  courseName: string;
  className: string;
  capacity: number;
}) {
  const teacher = await prisma.user.findUnique({
    where: { id: teacherUserId },
    include: { inviteCode: true },
  });
  if (!teacher || teacher.role !== UserRole.teacher) throw new Error("需要教师权限。");
  if (!teacher.inviteCode || teacher.inviteCode.level !== "level_1") {
    throw new Error("教师账号未关联一级邀请码。");
  }

  const created = await prisma.$transaction(async (transaction) => {
    const parent = await transaction.inviteCode.update({
      where: { id: teacher.inviteCode!.id },
      data: { nextClassSequence: { increment: 1 } },
    });
    const sequence = parent.nextClassSequence - 1;
    const code = `${parent.code}-${String(sequence).padStart(3, "0")}`;
    const classInvite = await transaction.inviteCode.create({
      data: {
        code,
        level: "level_2",
        description: `${input.courseName} / ${input.className}`,
        courseName: input.courseName.trim(),
        className: input.className.trim(),
        maxUses: input.capacity,
        expiresAt: null,
        parentInviteCodeId: parent.id,
        teacherUserId: teacher.id,
      },
      include: { parentInviteCode: true },
    });
    await transaction.user.update({
      where: { id: teacher.id },
      data: {
        currentClassInviteId: classInvite.id,
        courseName: classInvite.courseName,
      },
    });
    return classInvite;
  });

  await syncHomeworksInviteCode({
    code: created.code,
    level: created.level,
    courseName: created.courseName,
    className: created.className,
    parentCode: created.parentInviteCode?.code,
    teacherExternalId: teacher.id,
    maxUses: created.maxUses,
    usedCount: 0,
    isActive: created.isActive,
  });
  await syncHomeworksUser({
    externalId: teacher.id,
    email: teacher.email,
    name: teacher.name,
    role: teacher.role,
    studentNo: teacher.studentNo,
    courseName: created.courseName,
    className: created.className,
    inviteCode: teacher.inviteCode.code,
    classInviteCode: created.code,
    enabled: teacher.isActive,
  });
  return created;
}

export async function updateTeacherClass(teacherUserId: string, classInviteId: string, input: {
  className: string;
  capacity: number;
}) {
  const { actor, classInvite } = await getAccessibleClass(teacherUserId, classInviteId);
  if (actor.role !== UserRole.teacher) throw new Error("只有教师可以编辑班级。");

  const memberCount = await prisma.user.count({
    where: {
      inviteCodeId: classInvite.id,
      role: { in: [UserRole.student, UserRole.ta] },
    },
  });
  if (input.capacity < memberCount) {
    throw new Error(`人数上限不能低于当前成员数（${memberCount} 人）。`);
  }

  const updated = await prisma.inviteCode.update({
    where: { id: classInvite.id },
    data: {
      className: input.className.trim(),
      maxUses: input.capacity,
      description: `${classInvite.courseName ?? "课程"} / ${input.className.trim()}`,
    },
    include: { parentInviteCode: true },
  });

  await syncHomeworksInviteCode({
    code: updated.code,
    level: updated.level,
    courseName: updated.courseName,
    className: updated.className,
    parentCode: updated.parentInviteCode?.code,
    teacherExternalId: actor.id,
    maxUses: updated.maxUses,
    usedCount: updated.usedCount,
    isActive: updated.isActive,
    expiresAt: updated.expiresAt,
  });

  const classes = await listTeacherClasses(actor.id);
  return classes.find((item) => item.id === updated.id)!;
}

export async function selectTeacherClass(teacherUserId: string, classInviteId: string) {
  const { actor, classInvite } = await getAccessibleClass(teacherUserId, classInviteId);
  if (actor.role !== UserRole.teacher) throw new Error("只有教师可以切换工作班级。");
  if (!classInvite.isActive) throw new Error("该班级已停用，无法切换。");

  const updated = await prisma.user.update({
    where: { id: actor.id },
    data: {
      currentClassInviteId: classInvite.id,
      courseName: classInvite.courseName,
      lastLoginAt: new Date(),
    },
    include: { workspace: true, inviteCode: true, currentClassInvite: true },
  });
  await syncHomeworksUser({
    externalId: updated.id,
    email: updated.email,
    name: updated.name,
    role: updated.role,
    studentNo: updated.studentNo,
    courseName: classInvite.courseName,
    className: classInvite.className,
    inviteCode: updated.inviteCode?.code ?? null,
    classInviteCode: classInvite.code,
    enabled: updated.isActive,
  });
  return createAccountSession(updated);
}

export async function listClassMembers(actorUserId: string, classInviteId: string) {
  await getAccessibleClass(actorUserId, classInviteId);
  const users = await prisma.user.findMany({
    where: { inviteCodeId: classInviteId, role: { in: [UserRole.student, UserRole.ta] } },
    include: { workspace: true },
    orderBy: [{ role: "asc" }, { name: "asc" }, { email: "asc" }],
  });
  return users.map((user) => ({
    id: user.id,
    email: user.email,
    name: user.name,
    studentNo: user.studentNo,
    role: user.role,
    isActive: user.isActive,
    workspaceStatus: user.workspace?.status ?? "not_created",
    lastLoginAt: user.lastLoginAt,
  }));
}

export async function updateClassMemberRole(
  teacherUserId: string,
  classInviteId: string,
  memberUserId: string,
  role: "student" | "ta",
) {
  const { actor, classInvite } = await getAccessibleClass(teacherUserId, classInviteId);
  if (actor.role !== UserRole.teacher) throw new Error("只有教师可以修改助教角色。");
  const member = await prisma.user.findFirst({
    where: { id: memberUserId, inviteCodeId: classInvite.id, role: { in: [UserRole.student, UserRole.ta] } },
  });
  if (!member) throw new Error("班级成员不存在。");
  const updated = await prisma.user.update({ where: { id: member.id }, data: { role } });
  await syncHomeworksUser({
    externalId: updated.id,
    email: updated.email,
    name: updated.name,
    role: updated.role,
    studentNo: updated.studentNo,
    courseName: classInvite.courseName,
    className: classInvite.className,
    inviteCode: classInvite.code,
    enabled: updated.isActive,
  });
  return { id: updated.id, role: updated.role };
}

export async function deleteClassMember(actorUserId: string, classInviteId: string, memberUserId: string) {
  const { actor } = await getAccessibleClass(actorUserId, classInviteId);
  const member = await prisma.user.findFirst({
    where: { id: memberUserId, inviteCodeId: classInviteId, role: { in: [UserRole.student, UserRole.ta] } },
  });
  if (!member) throw new Error("班级成员不存在。");
  if (actor.role === UserRole.ta && member.role !== UserRole.student) {
    throw new Error("助教只能移除学生。");
  }
  return archiveAndDeleteManagedUsers({
    users: [{ id: member.id, email: member.email, role: member.role }],
    reason: { kind: "user", userId: member.id },
  });
}

export async function deleteTeacherClass(teacherUserId: string, classInviteId: string) {
  const { actor, classInvite } = await getAccessibleClass(teacherUserId, classInviteId);
  if (actor.role !== UserRole.teacher) throw new Error("只有教师可以删除班级。");
  const members = await prisma.user.findMany({
    where: { inviteCodeId: classInvite.id },
    select: { id: true, email: true, role: true },
  });
  const result = await archiveAndDeleteManagedUsers({
    users: members,
    reason: { kind: "invite_code", inviteCodeId: classInvite.id, code: classInvite.code },
    inviteCodeIds: [classInvite.id],
    inviteCodes: [classInvite.code],
  });
  if (actor.currentClassInviteId === classInvite.id) {
    const replacement = await prisma.inviteCode.findFirst({
      where: {
        level: "level_2",
        teacherUserId: actor.id,
        isActive: true,
        id: { not: classInvite.id },
      },
      orderBy: { code: "asc" },
    });
    await prisma.user.update({
      where: { id: actor.id },
      data: {
        currentClassInviteId: replacement?.id ?? null,
        courseName: replacement?.courseName ?? null,
      },
    });
    const teacher = await prisma.user.findUniqueOrThrow({
      where: { id: actor.id },
      include: { inviteCode: true },
    });
    await syncHomeworksUser({
      externalId: teacher.id,
      email: teacher.email,
      name: teacher.name,
      role: teacher.role,
      studentNo: teacher.studentNo,
      courseName: replacement?.courseName ?? null,
      className: replacement?.className ?? null,
      inviteCode: teacher.inviteCode?.code ?? null,
      classInviteCode: replacement?.code ?? null,
      enabled: teacher.isActive,
    });
  }
  return result;
}

export async function getTeacherClassProgress(actorUserId: string) {
  const classes = await listTeacherClasses(actorUserId);
  const result = [];
  for (const classItem of classes) {
    const students = await prisma.user.findMany({
      where: { inviteCodeId: classItem.id, role: UserRole.student },
      include: {
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
      orderBy: { createdAt: "asc" },
    });
    const configuredEmails = new Set((await prisma.aiProviderSelection.findMany({
      where: { ownerEmail: { in: students.map((student) => student.email.trim().toLowerCase()) } },
      select: { ownerEmail: true },
    })).map((item) => item.ownerEmail));
    result.push({
      ...classItem,
      students: students.map((student) => ({
        id: student.id,
        email: student.email,
        name: student.name,
        studentNo: student.studentNo,
        workspaceStatus: student.workspace?.status ?? "not_created",
        aiProviderConfigured: configuredEmails.has(student.email.trim().toLowerCase()),
        osType: student.workspace?.osType ?? null,
        targetArch: student.workspace?.targetArch ?? null,
        lastLoginAt: student.lastLoginAt,
        workspaceUpdatedAt: student.workspace?.updatedAt ?? null,
        lastAgentStatus: student.agentRuns[0]?.status ?? null,
        lastBuildStatus: student.agentRuns[0]?.buildRuns[0]?.status ?? null,
        lastQemuSmokeStatus: student.agentRuns[0]?.qemuSmokeRuns[0]?.status ?? null,
      })),
    });
  }
  return { classes: result };
}
