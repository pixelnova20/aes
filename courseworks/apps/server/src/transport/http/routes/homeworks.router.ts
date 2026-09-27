/**
 * 文件作用：提供 Courseworks 到 Homeworks 的单点登录入口。
 * 模块位置：`apps/server/src/transport/http/routes/homeworks.router.ts`，属于后端 HTTP 协议适配层。
 */
import { Router } from "express";

import { getCurrentAccount } from "../../../application/identity/account-application.service.js";
import { syncHomeworksUser } from "../../../infrastructure/management.js";
import { config } from "../../../config/index.js";
import { signHomeworksSsoToken, USER_ROLES } from "../../../modules/identity/index.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = Router();

router.get(
  "/sso-token",
  requireAuth,
  requireRoles(USER_ROLES.teacher, USER_ROLES.ta, USER_ROLES.student),
  async (request, response, next) => {
    try {
      const account = await getCurrentAccount(request.auth!.userId);
      if (!account) {
        response.status(401).json({ message: "需要登录后才能继续。" });
        return;
      }

      await syncHomeworksUser({
        externalId: account.id,
        email: account.email,
        name: account.name,
        role: account.role,
        studentNo: account.studentNo,
        courseName: account.currentClass?.courseName ?? account.courseName,
        className: account.currentClass?.className ?? account.inviteCode?.className ?? null,
        inviteCode: account.inviteCode?.code ?? null,
        classInviteCode: account.currentClass?.code ?? null,
        enabled: account.isActive,
      });

      const token = signHomeworksSsoToken({
        sub: account.id,
        role: account.role,
        email: account.email,
        classInviteCode: account.currentClass?.code ?? null,
      });
      const publicPath = config.HOMEWORKS_PUBLIC_PATH.replace(/\/$/, "");
      response.json({
        url: `${publicPath}/sso?token=${encodeURIComponent(token)}`,
      });
    } catch (error) {
      next(error);
    }
  },
);

export { router as homeworksRouter };
