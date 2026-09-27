import { Router } from "express";
import { z } from "zod";

import {
  joinStudentClass,
  leaveStudentClass,
  listStudentClasses,
  selectStudentClass,
  StudentClassError,
} from "../../../application/student/student-class-application.service.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = Router();
const joinSchema = z.object({
  inviteCode: z.string().trim().min(1, "请输入班级邀请码。").max(191),
});

router.use(requireAuth, requireRoles("student", "ta"));

router.get("/classes", async (request, response, next) => {
  try {
    response.json({ classes: await listStudentClasses(request.auth!.userId) });
  } catch (error) {
    if (error instanceof StudentClassError) {
      response.status(error.status).json({ message: error.message });
      return;
    }
    next(error);
  }
});

router.post("/classes", async (request, response, next) => {
  try {
    const parsed = joinSchema.parse(request.body);
    response.status(201).json({ class: await joinStudentClass(request.auth!.userId, parsed.inviteCode) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: error.issues[0]?.message ?? "班级邀请码无效。" });
      return;
    }
    if (error instanceof StudentClassError) {
      response.status(error.status).json({ message: error.message });
      return;
    }
    next(error);
  }
});

router.post("/classes/:accountId/select", async (request, response, next) => {
  try {
    response.json(await selectStudentClass(request.auth!.userId, String(request.params.accountId)));
  } catch (error) {
    if (error instanceof StudentClassError) {
      response.status(error.status).json({ message: error.message });
      return;
    }
    next(error);
  }
});

router.delete("/classes/:accountId", async (request, response, next) => {
  try {
    response.json(await leaveStudentClass(request.auth!.userId, String(request.params.accountId)));
  } catch (error) {
    if (error instanceof StudentClassError) {
      response.status(error.status).json({ message: error.message });
      return;
    }
    next(error);
  }
});

export { router as studentRouter };
