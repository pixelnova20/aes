/**
 * 文件作用：实现后端 HTTP 协议适配层中的 `requireAuth`、`requireRoles` 等能力。
 * 模块位置：`apps/server/src/transport/http/middleware/auth.ts`，属于后端 HTTP 协议适配层。
 * 重要函数：`requireAuth()` 负责处理`require` `auth`；`requireRoles()` 负责处理`require` `roles`。
 */
import type { NextFunction, Request, Response } from "express";

import { isConfiguredSuperuserSessionCurrent } from "../../../application/identity/account-application.service.js";
import { config } from "../../../config/index.js";
import {
  USER_ROLES,
  isUserRole,
  verifyHomeworkTutorToken,
  verifyToken,
  type UserRole,
} from "../../../modules/identity/index.js";

/**
 * 功能：处理`require` `auth`。
 * 输入：`request`（Request）提供请求。 `response`（Response）提供响应。 `next`（NextFunction）提供next。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `startsWith()`、`verifyToken()`、`isUserRole()`、`next()`。
 */
export async function requireAuth(request: Request, response: Response, next: NextFunction) {
  // 从 Bearer Token 中解析出当前请求的用户身份，并挂到 request.auth。
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    response.status(401).json({ message: "需要登录后才能继续。" });
    return;
  }

  try {
    const token = header.slice("Bearer ".length);
    const payload = verifyToken(token);
    if (!isUserRole(payload.role)) throw new Error("用户角色无效。");
    if (
      payload.role === USER_ROLES.superAdmin
      && payload.email?.trim().toLowerCase() !== config.SUPERUSER.email
    ) {
      throw new Error("超级用户配置已变更。");
    }
    if (payload.role === USER_ROLES.superAdmin) {
      const sessionIsCurrent = await isConfiguredSuperuserSessionCurrent(payload.sub, payload.iat);
      if (!sessionIsCurrent) throw new Error("超级用户凭据已变更，请重新登录。");
    }
    request.auth = {
      userId: payload.sub,
      role: payload.role,
      email: payload.email ?? "",
    };
    next();
  } catch {
    response.status(401).json({ message: "登录令牌无效或已过期。" });
  }
}

export function requireHomeworkTutorAuth(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    response.status(401).json({ message: "需要登录后才能继续。" });
    return;
  }

  try {
    const payload = verifyHomeworkTutorToken(header.slice("Bearer ".length));
    request.auth = {
      userId: payload.sub,
      role: "student",
      email: payload.email ?? "",
      homeworkTutorMode: payload.homeworkTutorMode,
    };
    next();
  } catch {
    response.status(401).json({ message: "Homeworks AI 辅导令牌无效或已过期。" });
  }
}

/**
 * 功能：处理`require` `roles`。
 * 输入：`roles`（UserRole[]）提供roles。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程`、`apps/server/src/transport/http/routes/admin.router.ts 顶层流程`、`apps/server/src/transport/http/routes/ai.router.ts 顶层流程`、`apps/server/src/transport/http/routes/code-navigation.router.ts 顶层流程`、`apps/server/src/transport/http/routes/teacher.router.ts 顶层流程` 调用；内部调用 `includes()`、`next()`。
 */
export function requireRoles(...roles: UserRole[]) {
  // 角色守卫：在 requireAuth 之后再限制更细的访问范围。
  return (request: Request, response: Response, next: NextFunction) => {
    if (!request.auth) {
      response.status(401).json({ message: "需要登录后才能继续。" });
      return;
    }

    if (!roles.includes(request.auth.role)) {
      response.status(403).json({ message: "无权执行此操作。" });
      return;
    }

    next();
  };
}
