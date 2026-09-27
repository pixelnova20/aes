import { InviteCodeLevel, UserRole } from "@prisma/client";

import {
  archiveAndDeleteManagedUsers,
  syncHomeworksInviteCode,
  syncHomeworksInviteCodeUsage,
  syncHomeworksUser,
} from "../../infrastructure/management.js";
import { prisma } from "../../infrastructure/prisma/client.js";
import { createAccountSession } from "../identity/account-application.service.js";

export class StudentClassError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message);
    this.name = "StudentClassError";
  }
}

async function getStudentClassAccount(userId: string) {
  const student = await prisma.user.findUnique({
    where: { id: userId },
  });
  if (!student || !student.isActive) {
    throw new StudentClassError("学生账号不存在或已被禁用。", 404);
  }
  if (student.role !== UserRole.student && student.role !== UserRole.ta) {
    throw new StudentClassError("只有学生或助教账号可以管理所属班级。", 403);
  }
  return student;
}

export async function listStudentClasses(userId: string) {
  const student = await getStudentClassAccount(userId);
  const accounts = await prisma.user.findMany({
    where: {
      email: student.email,
      role: { in: [UserRole.student, UserRole.ta] },
      inviteCodeId: { not: null },
    },
    include: {
      inviteCode: {
        include: { teacher: { select: { email: true, name: true } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return accounts
    .filter((account) => account.inviteCode?.level === InviteCodeLevel.level_2)
    .map((account) => ({
      accountId: account.id,
      courseName: account.inviteCode!.courseName,
      className: account.inviteCode!.className,
      inviteCode: account.inviteCode!.code,
      role: account.role,
      teacher: account.inviteCode!.teacher,
      isCurrent: account.id === student.id,
      isActive: account.isActive,
    }));
}

export async function joinStudentClass(userId: string, inviteCodeInput: string) {
  const student = await getStudentClassAccount(userId);
  const inviteCode = inviteCodeInput.trim();
  const invite = await prisma.inviteCode.findUnique({
    where: { code: inviteCode },
    include: { parentInviteCode: true },
  });
  if (!invite || invite.level !== InviteCodeLevel.level_2) {
    throw new StudentClassError("请输入有效的班级邀请码。", 400);
  }
  if (!invite.isActive) {
    throw new StudentClassError("该班级邀请码已停用。", 400);
  }
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
    throw new StudentClassError("该班级邀请码已过期。", 400);
  }
  if (invite.usedCount >= invite.maxUses) {
    throw new StudentClassError("该班级人数已满。", 409);
  }
  if (!student.studentNo) {
    throw new StudentClassError("当前学生账号缺少学号，无法加入班级。", 400);
  }

  const duplicate = await prisma.user.findFirst({
    where: { email: student.email, inviteCodeId: invite.id },
  });
  if (duplicate) {
    throw new StudentClassError("你已经加入该班级。", 409);
  }
  const duplicateStudentNo = await prisma.user.findFirst({
    where: { studentNo: student.studentNo, inviteCodeId: invite.id },
  });
  if (duplicateStudentNo) {
    throw new StudentClassError("该学号已经加入该班级。", 409);
  }

  const result = await prisma.$transaction(async (transaction) => {
    const claimed = await transaction.inviteCode.updateMany({
      where: {
        id: invite.id,
        level: InviteCodeLevel.level_2,
        isActive: true,
        usedCount: { lt: invite.maxUses },
      },
      data: { usedCount: { increment: 1 } },
    });
    if (claimed.count !== 1) {
      throw new StudentClassError("该班级人数已满或邀请码已停用。", 409);
    }

    const created = await transaction.user.create({
      data: {
        email: student.email,
        passwordHash: student.passwordHash,
        name: student.name,
        role: UserRole.student,
        studentNo: student.studentNo,
        courseName: invite.courseName,
        inviteCodeId: invite.id,
      },
    });
    await transaction.inviteCodeUse.create({
      data: { inviteCodeId: invite.id, userId: created.id },
    });
    const updatedInvite = await transaction.inviteCode.findUniqueOrThrow({
      where: { id: invite.id },
    });
    return { account: created, usedCount: updatedInvite.usedCount };
  });

  await syncHomeworksInviteCode({
    code: invite.code,
    level: invite.level,
    courseName: invite.courseName,
    className: invite.className,
    parentCode: invite.parentInviteCode?.code,
    teacherExternalId: invite.teacherUserId,
    maxUses: invite.maxUses,
    usedCount: result.usedCount,
    isActive: invite.isActive,
    expiresAt: invite.expiresAt,
  });
  await syncHomeworksUser({
    externalId: result.account.id,
    email: result.account.email,
    name: result.account.name,
    role: result.account.role,
    studentNo: result.account.studentNo,
    courseName: invite.courseName,
    className: invite.className,
    inviteCode: invite.code,
    enabled: result.account.isActive,
  });
  await syncHomeworksInviteCodeUsage(invite.code, result.usedCount);

  return {
    accountId: result.account.id,
    courseName: invite.courseName,
    className: invite.className,
    inviteCode: invite.code,
    role: result.account.role,
    isCurrent: false,
    isActive: result.account.isActive,
  };
}

export async function leaveStudentClass(userId: string, targetAccountId: string) {
  const student = await getStudentClassAccount(userId);
  const target = await prisma.user.findFirst({
    where: {
      id: targetAccountId,
      email: student.email,
      role: { in: [UserRole.student, UserRole.ta] },
      inviteCode: { is: { level: InviteCodeLevel.level_2 } },
    },
    include: { inviteCode: true },
  });
  if (!target || !target.inviteCode) {
    throw new StudentClassError("未找到要离开的班级。", 404);
  }

  const result = await archiveAndDeleteManagedUsers({
    users: [{ id: target.id, email: target.email, role: target.role }],
    reason: { kind: "user", userId: target.id },
  });
  return {
    ...result,
    currentAccountDeleted: target.id === student.id,
    className: target.inviteCode.className,
  };
}

export async function selectStudentClass(userId: string, targetAccountId: string) {
  const current = await getStudentClassAccount(userId);
  if (!current.studentNo) {
    throw new StudentClassError("当前账号缺少学号，无法切换班级。", 400);
  }

  const target = await prisma.user.findFirst({
    where: {
      id: targetAccountId,
      email: current.email,
      studentNo: current.studentNo,
      isActive: true,
      role: { in: [UserRole.student, UserRole.ta] },
      inviteCode: { is: { level: InviteCodeLevel.level_2, isActive: true } },
    },
    include: { workspace: true, inviteCode: true },
  });
  if (!target) {
    throw new StudentClassError("未找到可切换的班级账号。", 404);
  }

  await prisma.user.update({
    where: { id: target.id },
    data: { lastLoginAt: new Date() },
  });
  return createAccountSession(target);
}
