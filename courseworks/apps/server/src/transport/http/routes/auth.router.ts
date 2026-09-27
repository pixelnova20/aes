/**
 * 文件作用：把 HTTP 请求适配为后端应用层调用，并统一返回协议响应。
 * 模块位置：`apps/server/src/transport/http/routes/auth.router.ts`，属于后端 HTTP 协议适配层。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import { Router } from "express";
import { z } from "zod";

import {
  getCurrentAccount,
  getInviteRegistrationInfo,
  loginAccount,
  recordAccountLogout,
  registerAccount,
  updateCurrentAccount,
} from "../../../application/identity/account-application.service.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();
const optionalStudentNoSchema = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().regex(/^[A-Za-z0-9]+$/, "工号或学号只能包含英文字母和数字。").optional(),
);
const registerSchema = z.object({
  email: z.string().email("请输入有效的邮箱地址。"),
  password: z.string().min(6, "密码至少需要 6 个字符。"),
  confirmPassword: z.string().min(6, "确认密码至少需要 6 个字符。"),
  name: z.string().min(1, "请输入姓名。"),
  studentNo: optionalStudentNoSchema,
  inviteCode: z.string().min(1, "请输入邀请码。"),
});
const loginSchema = z.object({
  email: z.string().email("请输入有效的邮箱地址。"),
  password: z.string().min(6, "密码至少需要 6 个字符。"),
  accountId: z.string().min(1).optional(),
});
const accountUpdateSchema = z.object({
  name: z.string().trim().min(1, "请输入姓名。").max(255, "姓名不能超过 255 个字符。"),
  studentNo: optionalStudentNoSchema,
});

router.get("/invites/:code", async (request, response, next) => {
  try {
    response.json(await getInviteRegistrationInfo(request.params.code));
  } catch (error) {
    const message = error instanceof Error ? error.message : "邀请码查询失败。";
    if (message.startsWith("邀请码")) {
      response.status(400).json({ message });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 POST /register 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/register", async (request, response, next) => {
  try {
    const parsed = registerSchema.parse(request.body);
    if (parsed.password !== parsed.confirmPassword) {
      response.status(400).json({ message: "两次输入的密码不一致。" });
      return;
    }
    const result = await registerAccount(parsed);
    response.status(201).json(result);
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: error.issues[0]?.message ?? "请求参数无效。" });
      return;
    }
    const message = error instanceof Error ? error.message : "注册失败。";
    if (message.includes("已使用") || message.includes("已注册") || message.includes("已保留")) {
      response.status(409).json({ message });
      return;
    }
    if (message.includes("工号") || message.includes("学号")) {
      response.status(400).json({ message });
      return;
    }
    if (message.startsWith("邀请码")) {
      response.status(400).json({ message });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 POST /login 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/login", async (request, response, next) => {
  try {
    const parsed = loginSchema.parse(request.body);
    response.json(await loginAccount(parsed.email, parsed.password, parsed.accountId));
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: error.issues[0]?.message ?? "请求参数无效。" });
      return;
    }
    const message = error instanceof Error ? error.message : "登录失败。";
    if (message === "邮箱或密码错误。") {
      response.status(401).json({ message });
      return;
    }
    if (message === "该账号已被禁用。") {
      response.status(403).json({ message });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 GET /me 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/me", requireAuth, async (request, response, next) => {
  try {
    const account = await getCurrentAccount(request.auth!.userId);
    if (!account) {
      response.status(401).json({ message: "需要登录后才能继续。" });
      return;
    }
    response.json(account);
  } catch (error) {
    next(error);
  }
});

router.patch("/me", requireAuth, async (request, response, next) => {
  try {
    const parsed = accountUpdateSchema.parse(request.body);
    response.json(await updateCurrentAccount(request.auth!.userId, parsed));
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: error.issues[0]?.message ?? "账户资料无效。" });
      return;
    }
    const message = error instanceof Error ? error.message : "账户资料更新失败。";
    if (message.includes("学号") && message.includes("使用")) {
      response.status(409).json({ message });
      return;
    }
    if (message.includes("学号")) {
      response.status(400).json({ message });
      return;
    }
    next(error);
  }
});

router.post("/logout", requireAuth, async (request, response, next) => {
  try {
    await recordAccountLogout(request.auth!.userId);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

export { router as authRouter };
