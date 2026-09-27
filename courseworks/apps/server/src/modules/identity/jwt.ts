/**
 * 文件作用：实现后端“身份认证”业务模块中的 `signToken`、`verifyToken` 等能力。
 * 模块位置：`apps/server/src/modules/identity/jwt.ts`，属于后端“身份认证”业务模块。
 * 重要函数：`signToken()` 负责签发Token；`verifyToken()` 负责验证Token。
 */
import jwt from "jsonwebtoken";

import { config } from "../../config/index.js";

// JWT 里只放平台鉴权真正需要的最小身份信息。
type TokenPayload = {
  sub: string;
  role: string;
  email: string;
  name?: string | null;
  classInviteCode?: string | null;
  purpose?: string;
  service?: string;
  homeworkTutorMode?: "guidance" | "review";
  iat?: number;
};

/**
 * 功能：签发Token。
 * 输入：`payload`（TokenPayload）提供待处理的业务载荷。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/identity/account-application.service.ts:registerAccount()`、`apps/server/src/application/identity/account-application.service.ts:loginAccount()` 调用；内部调用 `sign()`。
 */
export function signToken(payload: TokenPayload) {
  // 当前平台使用固定 7 天有效期的登录态。
  return jwt.sign(payload, config.JWT_SECRET, { expiresIn: "7d" });
}

export function signHomeworksSsoToken(payload: TokenPayload) {
  return jwt.sign(
    { ...payload, purpose: "homeworks_sso" },
    config.JWT_SECRET,
    { expiresIn: "60s" },
  );
}

export function signServiceSsoToken(payload: TokenPayload, service: string) {
  return jwt.sign(
    { ...payload, purpose: "service_sso", service },
    config.JWT_SECRET,
    { expiresIn: "60s" },
  );
}

/**
 * 功能：验证Token。
 * 输入：`token`（string）提供Token。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/execution/vnc-bridge.service.ts:attachVncBridge()`、`apps/server/src/transport/http/middleware/auth.ts:requireAuth()` 调用；内部调用 `verify()`。
 */
export function verifyToken(token: string) {
  const payload = jwt.verify(token, config.JWT_SECRET) as TokenPayload;
  if (payload.purpose) throw new Error("Service SSO tokens cannot be used as access tokens.");
  return payload;
}

export function verifyHomeworkTutorToken(token: string) {
  const payload = jwt.verify(token, config.JWT_SECRET) as TokenPayload;
  if (
    payload.purpose !== "homeworks_ai_tutor"
    || payload.role !== "student"
    || !["guidance", "review"].includes(payload.homeworkTutorMode ?? "")
  ) {
    throw new Error("Invalid Homeworks AI tutor token.");
  }
  return payload as TokenPayload & { homeworkTutorMode: "guidance" | "review" };
}
