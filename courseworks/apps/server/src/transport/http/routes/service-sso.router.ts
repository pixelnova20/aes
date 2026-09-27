/** Issues short-lived SSO tokens for modules hosted behind the unified portal. */
import { Router } from "express";

import { getCurrentAccount } from "../../../application/identity/account-application.service.js";
import { config } from "../../../config/index.js";
import { syncHomeworksUser } from "../../../infrastructure/management.js";
import { signServiceSsoToken, USER_ROLES } from "../../../modules/identity/index.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = Router();
const services = {
  slideshow: config.SLIDESHOW_PUBLIC_PATH,
} as const;

router.get(
  "/:service/sso-token",
  requireAuth,
  requireRoles(USER_ROLES.teacher, USER_ROLES.ta, USER_ROLES.student),
  async (request, response, next) => {
    try {
      const service = String(request.params.service);
      if (!(service in services)) {
        response.status(404).json({ message: "服务不存在。" });
        return;
      }
      const account = await getCurrentAccount(request.auth!.userId);
      if (!account) {
        response.status(401).json({ message: "需要登录后才能继续。" });
        return;
      }

      // Keep the shared class/account data current before a module reads it.
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

      const token = signServiceSsoToken({
        sub: account.id,
        role: account.role,
        email: account.email,
        name: account.name,
      }, service);
      const publicPath = services[service as keyof typeof services].replace(/\/$/, "");
      response.json({ url: `${publicPath}/sso?token=${encodeURIComponent(token)}` });
    } catch (error) {
      next(error);
    }
  },
);

export { router as serviceSsoRouter };
