/**
 * 文件作用：提供教师只读评审学生 Courseworks 工作区的应用用例。
 * 模块位置：`apps/server/src/application/teacher`，属于教师评审能力。
 * 重要约束：所有读取都直接作用于学生原工作区，不复制文件，也不提供任何写入接口。
 */
import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import { UserRole, WorkspaceStatus } from "@prisma/client";

import { prisma } from "../../infrastructure/prisma/client.js";
import {
  assertNoSymlinkPath,
  assertWorkspaceRoot,
  ensureWorkspacePath,
  readDirectoryTree,
  type FileNode,
} from "../../modules/workspaces/index.js";

const REVIEW_MAX_FILE_BYTES = 512 * 1024;
const AUDIT_DIRECTORY_NAME = "audit";
const AUDIT_MATCH_FILE = "match.md";
const AUDIT_STATE_FILE = ".audit-state.json";

export class TeacherReviewError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400) {
    super(message);
    this.name = "TeacherReviewError";
  }
}

type ReviewStudent = {
  id: string;
  email: string;
  name: string | null;
  studentNo: string | null;
  role: UserRole;
  isActive: boolean;
  lastLoginAt: Date | null;
  workspace: {
    id: string;
    workspaceUuid: string;
    status: WorkspaceStatus;
    path: string;
  } | null;
  inviteCode: {
    id: string;
    code: string;
    courseName: string | null;
    className: string | null;
    teacherUserId: string | null;
  } | null;
};

type AuditLink = {
  name: string;
  studentId: string;
  studentNo: string | null;
  email: string;
  classCode: string;
  className: string | null;
  workspaceUuid: string;
  workspaceRoot: string;
};

async function teacherCanReviewStudent(teacherUserId: string, studentUserId: string): Promise<ReviewStudent> {
  const teacher = await prisma.user.findUnique({
    where: { id: teacherUserId },
    select: { id: true, role: true, currentClassInviteId: true },
  });
  if (!teacher) throw new TeacherReviewError("教师账号不存在。", 404);
  if (teacher.role !== UserRole.teacher) throw new TeacherReviewError("只有教师可以使用审核功能。", 403);
  if (!teacher.currentClassInviteId) throw new TeacherReviewError("请先选择当前工作班级。", 400);

  const student = await prisma.user.findFirst({
    where: {
      id: studentUserId,
      role: { in: [UserRole.student, UserRole.ta] },
      inviteCodeId: teacher.currentClassInviteId,
      inviteCode: {
        level: "level_2",
        teacherUserId: teacher.id,
      },
    },
    include: {
      workspace: true,
      inviteCode: {
        select: {
          id: true,
          code: true,
          courseName: true,
          className: true,
          teacherUserId: true,
        },
      },
    },
  });
  if (!student) throw new TeacherReviewError("该学生不属于教师管理的班级。", 403);
  return student;
}

function presentStudent(student: ReviewStudent) {
  return {
    id: student.id,
    email: student.email,
    name: student.name,
    studentNo: student.studentNo,
    role: student.role,
    isActive: student.isActive,
    lastLoginAt: student.lastLoginAt,
    workspaceStatus: student.workspace?.status ?? WorkspaceStatus.not_created,
    class: student.inviteCode ? {
      id: student.inviteCode.id,
      code: student.inviteCode.code,
      courseName: student.inviteCode.courseName,
      className: student.inviteCode.className,
    } : null,
  };
}

function safeAuditLinkName(student: ReviewStudent) {
  const base = (student.studentNo || student.email.split("@")[0] || student.id)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || student.id;
}

function teacherAuditPath(teacherProjectPath: string) {
  const workspaceRoot = path.resolve(path.dirname(teacherProjectPath));
  assertWorkspaceRoot(workspaceRoot);
  return path.join(workspaceRoot, AUDIT_DIRECTORY_NAME);
}

async function removeGeneratedLegacyAuditDirectory(teacherProjectPath: string) {
  const legacyAuditPath = path.join(teacherProjectPath, AUDIT_DIRECTORY_NAME);
  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(legacyAuditPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink() || (entry.isFile() && entry.name === AUDIT_MATCH_FILE)) {
      await fs.unlink(path.join(legacyAuditPath, entry.name));
    }
  }
  try {
    await fs.rmdir(legacyAuditPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
  }
}

async function ensureTeacherAuditDirectory(
  teacherWorkspacePath: string,
  classId: string,
  students: ReviewStudent[],
) {
  const auditPath = teacherAuditPath(teacherWorkspacePath);
  await removeGeneratedLegacyAuditDirectory(teacherWorkspacePath);
  await fs.mkdir(auditPath, { recursive: true });
  const usedNames = new Set<string>();
  const links: AuditLink[] = [];

  for (const student of students) {
    if (!student.workspace || student.workspace.status !== WorkspaceStatus.ready) continue;
    const workspaceRoot = path.resolve(path.dirname(student.workspace.path));
    assertWorkspaceRoot(workspaceRoot);
    const baseName = safeAuditLinkName(student);
    let linkName = baseName;
    let suffix = 2;
    while (usedNames.has(linkName)) linkName = `${baseName}-${suffix++}`;
    usedNames.add(linkName);
    links.push({
      name: linkName,
      studentId: student.id,
      studentNo: student.studentNo,
      email: student.email,
      classCode: student.inviteCode?.code ?? "",
      className: student.inviteCode?.className ?? null,
      workspaceUuid: student.workspace.workspaceUuid,
      workspaceRoot,
    });
  }

  const manifest = JSON.stringify({
    version: 1,
    classId,
    students: students.map((student) => ({
      id: student.id,
      email: student.email,
      name: student.name,
      studentNo: student.studentNo,
      role: student.role,
      isActive: student.isActive,
      classCode: student.inviteCode?.code ?? null,
      className: student.inviteCode?.className ?? null,
      workspaceUuid: student.workspace?.workspaceUuid ?? null,
      workspaceStatus: student.workspace?.status ?? WorkspaceStatus.not_created,
    })),
    links: links.map((link) => ({
      name: link.name,
      studentId: link.studentId,
      workspaceUuid: link.workspaceUuid,
    })),
  });

  let existingManifest = "";
  try {
    existingManifest = await fs.readFile(path.join(auditPath, AUDIT_STATE_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let linksMatch = existingManifest === manifest;
  if (linksMatch) {
    const expectedNames = new Set(links.map((link) => link.name));
    for (const link of links) {
      const linkPath = path.join(auditPath, link.name);
      try {
        const existing = await fs.lstat(linkPath);
        if (!existing.isSymbolicLink()) {
          linksMatch = false;
          break;
        }
        const currentTarget = await fs.readlink(linkPath);
        const expectedTarget = path.relative(auditPath, link.workspaceRoot) || ".";
        const targetStat = await fs.stat(linkPath);
        if (!targetStat.isDirectory() || currentTarget !== expectedTarget) {
          linksMatch = false;
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          linksMatch = false;
          break;
        }
        throw error;
      }
    }
    if (linksMatch) {
      for (const entry of await fs.readdir(auditPath, { withFileTypes: true })) {
        if (entry.isSymbolicLink() && !expectedNames.has(entry.name)) {
          linksMatch = false;
          break;
        }
      }
    }
    if (linksMatch) {
      try {
        await fs.access(path.join(auditPath, AUDIT_MATCH_FILE));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") linksMatch = false;
        else throw error;
      }
    }
  }

  if (linksMatch) return { auditPath, links };

  for (const link of links) {
    const linkPath = path.join(auditPath, link.name);
    try {
      const existing = await fs.lstat(linkPath);
      if (!existing.isSymbolicLink()) {
        await fs.unlink(linkPath);
      } else {
        const currentTarget = await fs.readlink(linkPath);
        const expectedTarget = path.relative(auditPath, link.workspaceRoot) || ".";
        if (currentTarget !== expectedTarget) await fs.unlink(linkPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await fs.lstat(linkPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.symlink(path.relative(auditPath, link.workspaceRoot), linkPath, "dir");
    }
  }

  for (const entry of await fs.readdir(auditPath, { withFileTypes: true })) {
    if (!entry.isSymbolicLink() || usedNames.has(entry.name)) continue;
    await fs.unlink(path.join(auditPath, entry.name));
  }

  const matchLines = [
    "# 学生工作区映射",
    "",
    "本目录中的学生目录是符号链接，目标仍是学生原始工作区；审核系统不会复制学生文件。",
    "",
    "| 审核目录 | 学号 | 姓名邮箱 | 班级 | 工作区 UUID |",
    "| --- | --- | --- | --- | --- |",
    ...students.map((student) => {
      const link = links.find((item) => item.studentId === student.id);
      const label = `${student.name || "未填写姓名"} <${student.email}>`;
      return `| ${link ? `\`${link.name}\`` : "（工作区未就绪）"} | ${student.studentNo || "未填写"} | ${label} | ${student.inviteCode?.className || student.inviteCode?.code || "未命名班级"} | ${student.workspace?.workspaceUuid || "未创建"} |`;
    }),
    "",
  ];
  await fs.writeFile(path.join(auditPath, AUDIT_MATCH_FILE), matchLines.join("\n"), "utf8");
  await fs.writeFile(path.join(auditPath, AUDIT_STATE_FILE), manifest, "utf8");
  return { auditPath, links };
}

async function teacherAuditContext(teacherUserId: string) {
  const teacher = await prisma.user.findUnique({
    where: { id: teacherUserId },
    select: { id: true, role: true, currentClassInviteId: true },
  });
  if (!teacher) throw new TeacherReviewError("教师账号不存在。", 404);
  if (teacher.role !== UserRole.teacher) throw new TeacherReviewError("只有教师可以使用审核功能。", 403);
  if (!teacher.currentClassInviteId) throw new TeacherReviewError("请先选择当前工作班级。", 400);
  const teacherWorkspace = await prisma.workspace.findUnique({ where: { userId: teacher.id } });
  if (!teacherWorkspace || teacherWorkspace.status !== WorkspaceStatus.ready) {
    throw new TeacherReviewError("请先在 Courseworks 工作区初始化教师工程，再进入审核模式。", 400);
  }
  const currentClass = await prisma.inviteCode.findFirst({
    where: {
      id: teacher.currentClassInviteId,
      level: "level_2",
      teacherUserId: teacher.id,
      isActive: true,
    },
    include: {
      users: {
        where: { role: { in: [UserRole.student, UserRole.ta] } },
        include: { workspace: true, inviteCode: {
          select: { id: true, code: true, courseName: true, className: true, teacherUserId: true },
        } },
        orderBy: [{ role: "asc" }, { name: "asc" }, { email: "asc" }],
      },
    },
  });
  if (!currentClass) throw new TeacherReviewError("当前工作班级不存在或已停用。", 400);
  const classes = [currentClass];
  const students = currentClass.users;
  const audit = await ensureTeacherAuditDirectory(teacherWorkspace.path, currentClass.id, students);
  return { teacher, teacherWorkspace, currentClass, classes, students, audit };
}

export async function listTeacherReviewStudents(teacherUserId: string) {
  const { classes } = await teacherAuditContext(teacherUserId);

  return {
    audit: { directory: AUDIT_DIRECTORY_NAME, matchFile: AUDIT_MATCH_FILE },
    classes: classes.map((classInvite) => ({
      id: classInvite.id,
      code: classInvite.code,
      courseName: classInvite.courseName,
      className: classInvite.className,
      students: classInvite.users.map(presentStudent),
    })),
  };
}

function auditPathFor(teacherWorkspacePath: string, relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TeacherReviewError("审核路径无效。", 400);
  }
  const auditPath = teacherAuditPath(teacherWorkspacePath);
  const fullPath = path.resolve(auditPath, normalized);
  const relative = path.relative(auditPath, fullPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new TeacherReviewError("审核路径无效。", 400);
  return { normalized, fullPath, auditPath };
}

async function auditRealPath(
  context: Awaited<ReturnType<typeof teacherAuditContext>>,
  relativePath: string,
) {
  const { normalized, fullPath, auditPath } = auditPathFor(context.teacherWorkspace.path, relativePath);
  const firstSegment = normalized.split("/")[0];
  if (firstSegment !== AUDIT_MATCH_FILE) {
    const link = context.audit.links.find((item) => item.name === firstSegment);
    if (!link) throw new TeacherReviewError("该审核目录不属于教师管理的学生。", 403);
    const suffix = normalized.split("/").slice(1);
    const targetPath = path.resolve(link.workspaceRoot, ...suffix);
    const targetRelative = path.relative(link.workspaceRoot, targetPath);
    if (targetRelative.startsWith("..") || path.isAbsolute(targetRelative)) throw new TeacherReviewError("审核路径无效。", 400);
    const resolved = await fs.realpath(targetPath);
    const resolvedRelative = path.relative(link.workspaceRoot, resolved);
    if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative)) throw new TeacherReviewError("审核路径越界。", 403);
    return { normalized, fullPath: resolved, auditPath, link };
  }
  if (normalized !== AUDIT_MATCH_FILE) throw new TeacherReviewError("审核路径无效。", 400);
  return { normalized, fullPath, auditPath, link: null };
}

async function readAuditTree(
  context: Awaited<ReturnType<typeof teacherAuditContext>>,
  root: string,
  current = "",
  visited = new Set<string>(),
): Promise<FileNode[]> {
  const directoryPath = path.join(root, current);
  const realDirectory = await fs.realpath(directoryPath);
  if (visited.has(realDirectory)) return [];
  visited.add(realDirectory);
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const children: FileNode[] = [];
  for (const entry of entries.sort((left, right) => Number(right.isDirectory()) - Number(left.isDirectory()) || left.name.localeCompare(right.name))) {
    const relativePath = path.posix.join(current.replace(/\\/g, "/"), entry.name);
    if (current === "" && entry.name !== AUDIT_MATCH_FILE && !context.audit.links.some((link) => link.name === entry.name)) continue;
    if (entry.isSymbolicLink()) {
      if (current !== "") continue;
      const linkPath = path.join(directoryPath, entry.name);
      const targetStat = await fs.stat(linkPath);
      if (targetStat.isDirectory()) {
        children.push({ name: entry.name, path: relativePath, type: "directory", children: await readAuditTree(context, root, relativePath, new Set(visited)) });
      } else {
        children.push({ name: entry.name, path: relativePath, type: "file" });
      }
      continue;
    }
    if (entry.isDirectory()) {
      children.push({ name: entry.name, path: relativePath, type: "directory", children: await readAuditTree(context, root, relativePath, new Set(visited)) });
    } else {
      children.push({ name: entry.name, path: relativePath, type: "file" });
    }
  }
  return children;
}

export async function getTeacherAuditTree(teacherUserId: string) {
  const context = await teacherAuditContext(teacherUserId);
  return {
    audit: { directory: AUDIT_DIRECTORY_NAME, matchFile: AUDIT_MATCH_FILE },
    tree: await readAuditTree(context, context.audit.auditPath),
  };
}

export async function readTeacherAuditFile(teacherUserId: string, relativePath: string) {
  const context = await teacherAuditContext(teacherUserId);
  const resolved = await auditRealPath(context, relativePath);
  const stat = await fs.stat(resolved.fullPath);
  if (!stat.isFile()) throw new TeacherReviewError("该路径不是文件。", 400);
  if (stat.size > REVIEW_MAX_FILE_BYTES) throw new TeacherReviewError("文件过大，暂不支持在审核页面预览。", 400);
  return { path: resolved.normalized, content: await fs.readFile(resolved.fullPath, "utf8"), sizeBytes: stat.size };
}

async function getReviewWorkspace(teacherUserId: string, studentUserId: string) {
  const student = await teacherCanReviewStudent(teacherUserId, studentUserId);
  if (!student.workspace || student.workspace.status !== WorkspaceStatus.ready) {
    throw new TeacherReviewError("该学生的工作区尚未就绪。", 400);
  }
  return { student, workspace: student.workspace };
}

export async function getTeacherReviewTree(teacherUserId: string, studentUserId: string) {
  const { student, workspace } = await getReviewWorkspace(teacherUserId, studentUserId);
  return { student: presentStudent(student), tree: await readDirectoryTree(workspace.path) };
}

export async function readTeacherReviewFile(
  teacherUserId: string,
  studentUserId: string,
  relativePath: string,
) {
  const { student, workspace } = await getReviewWorkspace(teacherUserId, studentUserId);
  const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalizedPath || normalizedPath.split("/").some((segment) => !segment || segment.startsWith("."))) {
    throw new TeacherReviewError("只能读取公开的工程文件。", 400);
  }
  await assertNoSymlinkPath(workspace.path, normalizedPath);
  const fullPath = ensureWorkspacePath(normalizedPath, workspace.path);
  const stat = await fs.stat(fullPath);
  if (!stat.isFile()) throw new TeacherReviewError("该路径不是文件。", 400);
  if (stat.size > REVIEW_MAX_FILE_BYTES) {
    throw new TeacherReviewError("文件过大，暂不支持在审核页面预览。", 400);
  }
  const content = await fs.readFile(fullPath, "utf8");
  return {
    student: presentStudent(student),
    path: normalizedPath,
    content,
    sizeBytes: stat.size,
  };
}

export async function getTeacherReviewAgentContext(teacherUserId: string) {
  const context = await teacherAuditContext(teacherUserId);
  return {
    teacherWorkspace: context.teacherWorkspace,
    auditPath: context.audit.auditPath,
    classCode: context.currentClass.code,
    readableStudentCount: context.audit.links.length,
    totalStudentCount: context.students.length,
    readableWorkspaceRoots: context.audit.links.map((link) => link.workspaceRoot),
  };
}

export type TeacherReviewTree = FileNode[];
