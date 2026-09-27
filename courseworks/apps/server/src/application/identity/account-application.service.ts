import { timingSafeEqual } from "node:crypto";

import { InviteCodeLevel, UserRole } from "@prisma/client";

import { config } from "../../config/index.js";
import {
  syncHomeworksInviteCodeUsage,
  syncHomeworksUser,
} from "../../infrastructure/management.js";
import { prisma } from "../../infrastructure/prisma/client.js";
import { DEFAULT_AI_PROVIDER_PROFILE } from "../../modules/ai-settings/index.js";
import { comparePassword, hashPassword, signToken } from "../../modules/identity/index.js";

const STUDENT_NO_RE = /^[A-Za-z0-9]+$/;

function isConfiguredSuperuserEmail(email: string) {
  return email.trim().toLowerCase() === config.SUPERUSER.email;
}

function configuredSuperuserPasswordMatches(password: string) {
  const actual = Buffer.from(password);
  const expected = Buffer.from(config.SUPERUSER.password);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function ensureConfiguredSuperuser() {
  const result = await prisma.$transaction(async (transaction) => {
    const existing = await transaction.user.findFirst({
      where: { email: config.SUPERUSER.email, inviteCodeId: null },
      orderBy: { createdAt: "asc" },
      include: { workspace: true, inviteCode: true, currentClassInvite: true },
    });
    const displaced = await transaction.user.findMany({
      where: {
        role: UserRole.super_admin,
        ...(existing ? { id: { not: existing.id } } : {}),
      },
    });

    if (displaced.length > 0) {
      await transaction.user.updateMany({
        where: { id: { in: displaced.map((user) => user.id) } },
        data: { isActive: false },
      });
    }

    const credentialsAreCurrent = existing
      ? await comparePassword(config.SUPERUSER.password, existing.passwordHash)
      : false;
    const user = await (async () => {
      if (!existing) {
        return transaction.user.create({
          data: {
            email: config.SUPERUSER.email,
            name: "超级管理员",
            passwordHash: await hashPassword(config.SUPERUSER.password),
            role: UserRole.super_admin,
            isActive: true,
          },
          include: { workspace: true, inviteCode: true, currentClassInvite: true },
        });
      }
      if (credentialsAreCurrent && existing.role === UserRole.super_admin && existing.isActive) {
        return existing;
      }
      return transaction.user.update({
        where: { id: existing.id },
        data: {
          ...(!credentialsAreCurrent
            ? { passwordHash: await hashPassword(config.SUPERUSER.password) }
            : {}),
          role: UserRole.super_admin,
          isActive: true,
        },
        include: { workspace: true, inviteCode: true, currentClassInvite: true },
      });
    })();

    return { user, displaced };
  });

  for (const user of result.displaced) {
    await syncHomeworksUser({
      externalId: user.id,
      email: user.email,
      name: user.name,
      role: UserRole.super_admin,
      enabled: false,
    });
  }
  await syncHomeworksUser({
    externalId: result.user.id,
    email: result.user.email,
    password: config.SUPERUSER.password,
    name: result.user.name,
    role: UserRole.super_admin,
    enabled: true,
  });
  return result.user;
}

export async function isConfiguredSuperuserSessionCurrent(
  userId: string,
  issuedAt?: number,
) {
  const configuredSuperuser = await prisma.user.findFirst({
    where: {
      id: userId,
      email: config.SUPERUSER.email,
      role: UserRole.super_admin,
      isActive: true,
      inviteCodeId: null,
    },
    select: { updatedAt: true },
  });
  if (!configuredSuperuser) return false;
  return typeof issuedAt !== "number"
    || Math.floor(configuredSuperuser.updatedAt.getTime() / 1000) <= issuedAt;
}

export function createAccountSession(user: {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  courseName?: string | null;
  inviteCode?: { className: string | null } | null;
  currentClassInvite?: { courseName: string | null; className: string | null } | null;
  workspace?: { status: string } | null;
}) {
  const currentClass = user.role === UserRole.teacher ? user.currentClassInvite : null;
  return {
    token: signToken({ sub: user.id, role: user.role, email: user.email }),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      courseName: currentClass?.courseName ?? user.courseName ?? null,
      className: currentClass?.className ?? user.inviteCode?.className ?? null,
      workspaceStatus: user.workspace?.status ?? "not_created",
    },
  };
}

export async function getInviteRegistrationInfo(code: string) {
  const invite = await prisma.inviteCode.findUnique({ where: { code } });
  if (!invite || !invite.isActive) throw new Error("邀请码无效或已停用。");
  if (invite.level === InviteCodeLevel.level_1 && invite.usedCount >= 1) {
    throw new Error("邀请码使用次数已达上限。");
  }
  if (invite.level === InviteCodeLevel.level_2 && invite.usedCount >= invite.maxUses) {
    throw new Error("邀请码使用次数已达上限。");
  }
  return {
    code: invite.code,
    level: invite.level,
    role: invite.level === InviteCodeLevel.level_1 ? UserRole.teacher : UserRole.student,
    courseName: invite.courseName,
    className: invite.className,
  };
}

export async function registerAccount(input: {
  email: string;
  password: string;
  name: string;
  studentNo?: string;
  inviteCode: string;
}) {
  const email = input.email.trim().toLowerCase();
  const code = input.inviteCode.trim();
  const invite = await prisma.inviteCode.findUnique({ where: { code } });
  if (!invite || !invite.isActive) throw new Error("邀请码无效或已停用。");
  if (isConfiguredSuperuserEmail(email)) throw new Error("该邮箱已保留给管理员账号。");

  const role = invite.level === InviteCodeLevel.level_1 ? UserRole.teacher : UserRole.student;
  const studentNo = input.studentNo?.trim() || null;
  const identifierLabel = role === UserRole.teacher ? "教师工号" : "学生学号";
  if (!studentNo) {
    throw new Error(`请输入${identifierLabel}。`);
  }
  if (!STUDENT_NO_RE.test(studentNo)) {
    throw new Error(`${identifierLabel}只能包含英文字母和数字。`);
  }

  const duplicate = await prisma.user.findFirst({ where: { email, inviteCodeId: invite.id } });
  if (duplicate) throw new Error("该邮箱已使用此邀请码注册。");
  if (role === UserRole.teacher) {
    const existingTeacher = await prisma.user.findFirst({ where: { email, role: UserRole.teacher } });
    if (existingTeacher) throw new Error("该邮箱已注册教师账号。");
  }
  if (studentNo) {
    const duplicateStudentNo = await prisma.user.findFirst({
      where: { studentNo, inviteCodeId: invite.id },
    });
    if (duplicateStudentNo) throw new Error(`该${identifierLabel}已使用此邀请码注册。`);
  }

  const passwordHash = await hashPassword(input.password);
  const result = await prisma.$transaction(async (transaction) => {
    const claimed = await transaction.inviteCode.updateMany({
      where: {
        id: invite.id,
        isActive: true,
        usedCount: { lt: role === UserRole.teacher ? 1 : invite.maxUses },
      },
      data: { usedCount: { increment: 1 } },
    });
    if (claimed.count !== 1) throw new Error("邀请码使用次数已达上限。");

    const created = await transaction.user.create({
      data: {
        email,
        passwordHash,
        name: input.name.trim(),
        role,
        studentNo,
        courseName: invite.courseName,
        inviteCodeId: invite.id,
        lastLoginAt: new Date(),
      },
      include: { workspace: true, inviteCode: true },
    });
    await transaction.inviteCodeUse.create({
      data: { inviteCodeId: invite.id, userId: created.id },
    });
    if (role === UserRole.teacher) {
      await transaction.inviteCode.update({
        where: { id: invite.id },
        data: { teacherUserId: created.id },
      });
    }
    const defaultProfile = await transaction.aiProviderProfile.upsert({
      where: { ownerEmail_name: { ownerEmail: email, name: DEFAULT_AI_PROVIDER_PROFILE.name } },
      create: { ownerEmail: email, ...DEFAULT_AI_PROVIDER_PROFILE },
      update: {},
    });
    await transaction.aiProviderSelection.upsert({
      where: { ownerEmail: email },
      create: { ownerEmail: email, profileId: defaultProfile.id },
      update: {},
    });
    return created;
  });

  await syncHomeworksUser({
    externalId: result.id,
    email: result.email,
    password: input.password,
    name: result.name,
    role: result.role,
    studentNo: result.studentNo,
    courseName: invite.courseName,
    className: invite.className,
    inviteCode: invite.code,
    enabled: result.isActive,
  });
  await syncHomeworksInviteCodeUsage(invite.code, invite.usedCount + 1);
  return createAccountSession(result);
}

export async function loginAccount(emailInput: string, password: string, accountId?: string) {
  const email = emailInput.trim().toLowerCase();
  if (isConfiguredSuperuserEmail(email)) {
    if (!configuredSuperuserPasswordMatches(password)) throw new Error("邮箱或密码错误。");
    const superuser = await ensureConfiguredSuperuser();
    await prisma.user.update({ where: { id: superuser.id }, data: { lastLoginAt: new Date() } });
    return createAccountSession(superuser);
  }

  const candidates = await prisma.user.findMany({
    where: {
      email,
      role: { not: UserRole.super_admin },
      ...(accountId ? { id: accountId } : {}),
    },
    include: { workspace: true, inviteCode: true, currentClassInvite: true },
    orderBy: { createdAt: "asc" },
  });
  const passwordMatches = [];
  for (const candidate of candidates) {
    if (await comparePassword(password, candidate.passwordHash)) passwordMatches.push(candidate);
  }
  if (passwordMatches.length === 0) throw new Error("邮箱或密码错误。");

  const activeMatches = passwordMatches.filter((candidate) => candidate.isActive);
  if (activeMatches.length === 0) throw new Error("该账号已被禁用。");
  const onlyStudentClassAccounts = activeMatches.every((candidate) =>
    (candidate.role === UserRole.student || candidate.role === UserRole.ta)
    && candidate.inviteCode?.level === InviteCodeLevel.level_2
  );
  if (!accountId && activeMatches.length > 1 && !onlyStudentClassAccounts) {
    return {
      requiresAccountSelection: true as const,
      accounts: activeMatches.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        role: candidate.role,
        courseName: candidate.currentClassInvite?.courseName ?? candidate.courseName,
        className: candidate.currentClassInvite?.className ?? candidate.inviteCode?.className ?? null,
      })),
    };
  }

  const user = !accountId && onlyStudentClassAccounts
    ? [...activeMatches].sort((left, right) => {
        const lastUsed = (right.lastLoginAt?.getTime() ?? 0) - (left.lastLoginAt?.getTime() ?? 0);
        return lastUsed || left.createdAt.getTime() - right.createdAt.getTime();
      })[0]!
    : activeMatches[0]!;
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  try {
    await syncHomeworksUser({
      externalId: user.id,
      email: user.email,
      password,
      name: user.name,
      role: user.role,
      studentNo: user.studentNo,
      courseName: user.currentClassInvite?.courseName ?? user.courseName,
      className: user.currentClassInvite?.className ?? user.inviteCode?.className ?? null,
      inviteCode: user.inviteCode?.code ?? null,
      classInviteCode: user.currentClassInvite?.code ?? null,
      enabled: user.isActive,
    });
  } catch (error) {
    console.warn("[homeworks-sync] login sync failed", error);
  }
  return createAccountSession(user);
}

export async function recordAccountLogout(userId: string) {
  await prisma.user.updateMany({
    where: { id: userId, isActive: true },
    data: { lastLoginAt: new Date() },
  });
}

export async function getCurrentAccount(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { workspace: true, inviteCode: true, currentClassInvite: true },
  });
  if (!user || !user.isActive) return null;
  const aiProviderConfigured = await prisma.aiProviderSelection.count({
    where: { ownerEmail: user.email.trim().toLowerCase() },
  });
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    studentNo: user.studentNo,
    courseName: user.currentClassInvite?.courseName ?? user.courseName,
    isActive: user.isActive,
    inviteCode: user.inviteCode ? {
      code: user.inviteCode.code,
      level: user.inviteCode.level,
      className: user.inviteCode.className,
    } : null,
    currentClass: user.currentClassInvite ? {
      id: user.currentClassInvite.id,
      code: user.currentClassInvite.code,
      courseName: user.currentClassInvite.courseName,
      className: user.currentClassInvite.className,
    } : null,
    workspace: user.workspace,
    aiProviderConfigured: aiProviderConfigured > 0,
  };
}

export async function updateCurrentAccount(userId: string, input: { name: string; studentNo?: string }) {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    include: { inviteCode: true, currentClassInvite: true },
  });
  if (!existing || !existing.isActive) throw new Error("用户不存在或已被禁用。");

  const isStudentAccount = existing.role === UserRole.student || existing.role === UserRole.ta;
  const studentNo = isStudentAccount ? input.studentNo?.trim() : undefined;
  if (isStudentAccount && !studentNo) throw new Error("请输入学号。");

  const relatedAccounts = isStudentAccount
    ? await prisma.user.findMany({
        where: {
          email: existing.email,
          role: { in: [UserRole.student, UserRole.ta] },
          isActive: true,
        },
        include: { inviteCode: true, currentClassInvite: true },
      })
    : [existing];

  if (studentNo) {
    const inviteCodeIds = relatedAccounts
      .map((account) => account.inviteCodeId)
      .filter((id): id is string => Boolean(id));
    const conflict = await prisma.user.findFirst({
      where: {
        id: { notIn: relatedAccounts.map((account) => account.id) },
        studentNo,
        inviteCodeId: { in: inviteCodeIds },
      },
      select: { id: true },
    });
    if (conflict) throw new Error("该学号已被当前班级的其他学生使用。");
  }

  await prisma.$transaction(
    relatedAccounts.map((account) => prisma.user.update({
      where: { id: account.id },
      data: {
        name: input.name.trim(),
        ...(studentNo ? { studentNo } : {}),
      },
    })),
  );

  const updatedAccounts = await prisma.user.findMany({
    where: { id: { in: relatedAccounts.map((account) => account.id) } },
    include: { inviteCode: true, currentClassInvite: true },
  });
  for (const updated of updatedAccounts) {
    await syncHomeworksUser({
      externalId: updated.id,
      email: updated.email,
      name: updated.name,
      role: updated.role,
      studentNo: updated.studentNo,
      courseName: updated.currentClassInvite?.courseName ?? updated.courseName,
      className: updated.currentClassInvite?.className ?? updated.inviteCode?.className ?? null,
      inviteCode: updated.inviteCode?.code ?? null,
      classInviteCode: updated.currentClassInvite?.code ?? null,
      enabled: updated.isActive,
    });
  }
  return getCurrentAccount(existing.id);
}
