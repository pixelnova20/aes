import { Router } from "express";
import { z } from "zod";

import {
  createTeacherClass,
  deleteClassMember,
  deleteTeacherClass,
  getTeacherClassProgress,
  listClassMembers,
  listTeacherClasses,
  selectTeacherClass,
  updateTeacherClass,
  updateClassMemberRole,
} from "../../../application/teacher/teacher-application.service.js";
import {
  getTeacherReviewTree,
  getTeacherAuditTree,
  listTeacherReviewStudents,
  readTeacherAuditFile,
  readTeacherReviewFile,
  TeacherReviewError,
} from "../../../application/teacher/teacher-review-application.service.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = Router();
const classSchema = z.object({
  courseName: z.string().trim().min(1).max(255),
  className: z.string().trim().min(1).max(191),
  capacity: z.number().int().min(1).max(10000),
});
const memberRoleSchema = z.object({ role: z.enum(["student", "ta"]) });
const classUpdateSchema = classSchema.pick({ className: true, capacity: true });

router.use(requireAuth, requireRoles("teacher", "ta"));

router.get("/classes", async (request, response, next) => {
  try {
    response.json({ classes: await listTeacherClasses(request.auth!.userId) });
  } catch (error) { next(error); }
});

router.post("/classes", requireRoles("teacher"), async (request, response, next) => {
  try {
    const parsed = classSchema.parse(request.body);
    response.status(201).json({ class: await createTeacherClass(request.auth!.userId, parsed) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: error.issues[0]?.message ?? "班级信息无效。" });
      return;
    }
    next(error);
  }
});

router.post("/classes/:classId/select", requireRoles("teacher"), async (request, response, next) => {
  try {
    response.json(await selectTeacherClass(request.auth!.userId, String(request.params.classId)));
  } catch (error) { next(error); }
});

router.patch("/classes/:classId", requireRoles("teacher"), async (request, response, next) => {
  try {
    const parsed = classUpdateSchema.parse(request.body);
    response.json({
      class: await updateTeacherClass(
        request.auth!.userId,
        String(request.params.classId),
        parsed,
      ),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: error.issues[0]?.message ?? "班级信息无效。" });
      return;
    }
    if (error instanceof Error) {
      response.status(400).json({ message: error.message });
      return;
    }
    next(error);
  }
});

router.delete("/classes/:classId", requireRoles("teacher"), async (request, response, next) => {
  try {
    response.json(await deleteTeacherClass(request.auth!.userId, String(request.params.classId)));
  } catch (error) { next(error); }
});

router.get("/classes/:classId/members", async (request, response, next) => {
  try {
    response.json({ members: await listClassMembers(request.auth!.userId, String(request.params.classId)) });
  } catch (error) { next(error); }
});

router.patch("/classes/:classId/members/:memberId/role", requireRoles("teacher"), async (request, response, next) => {
  try {
    const parsed = memberRoleSchema.parse(request.body);
    response.json(await updateClassMemberRole(
      request.auth!.userId,
      String(request.params.classId),
      String(request.params.memberId),
      parsed.role,
    ));
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "班级角色无效。" });
      return;
    }
    next(error);
  }
});

router.delete("/classes/:classId/members/:memberId", async (request, response, next) => {
  try {
    response.json(await deleteClassMember(
      request.auth!.userId,
      String(request.params.classId),
      String(request.params.memberId),
    ));
  } catch (error) { next(error); }
});

router.get("/class-progress", async (request, response, next) => {
  try {
    response.json(await getTeacherClassProgress(request.auth!.userId));
  } catch (error) { next(error); }
});

router.get("/review", requireRoles("teacher"), async (request, response, next) => {
  try {
    response.json(await listTeacherReviewStudents(request.auth!.userId));
  } catch (error) {
    if (error instanceof TeacherReviewError) {
      response.status(error.status).json({ message: error.message });
      return;
    }
    next(error);
  }
});

router.get("/review/audit/tree", requireRoles("teacher"), async (request, response, next) => {
  try {
    response.json(await getTeacherAuditTree(request.auth!.userId));
  } catch (error) {
    if (error instanceof TeacherReviewError) {
      response.status(error.status).json({ message: error.message });
      return;
    }
    next(error);
  }
});

router.get("/review/audit/file", requireRoles("teacher"), async (request, response, next) => {
  try {
    const relativePath = typeof request.query.path === "string" ? request.query.path : "";
    response.json(await readTeacherAuditFile(request.auth!.userId, relativePath));
  } catch (error) {
    if (error instanceof TeacherReviewError) {
      response.status(error.status).json({ message: error.message });
      return;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      response.status(404).json({ message: "文件不存在。" });
      return;
    }
    next(error);
  }
});

router.get("/review/students/:studentId/tree", requireRoles("teacher"), async (request, response, next) => {
  try {
    response.json(await getTeacherReviewTree(
      request.auth!.userId,
      String(request.params.studentId),
    ));
  } catch (error) {
    if (error instanceof TeacherReviewError) {
      response.status(error.status).json({ message: error.message });
      return;
    }
    next(error);
  }
});

router.get("/review/students/:studentId/file", requireRoles("teacher"), async (request, response, next) => {
  try {
    const relativePath = typeof request.query.path === "string" ? request.query.path : "";
    response.json(await readTeacherReviewFile(
      request.auth!.userId,
      String(request.params.studentId),
      relativePath,
    ));
  } catch (error) {
    if (error instanceof TeacherReviewError) {
      response.status(error.status).json({ message: error.message });
      return;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      response.status(404).json({ message: "文件不存在。" });
      return;
    }
    next(error);
  }
});

export { router as teacherRouter };
