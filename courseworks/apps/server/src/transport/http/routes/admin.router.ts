/**
 * 文件作用：把 HTTP 请求适配为后端应用层调用，并统一返回协议响应。
 * 模块位置：`apps/server/src/transport/http/routes/admin.router.ts`，属于后端 HTTP 协议适配层。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import { Router } from "express";
import { z } from "zod";

import {
  createInviteCode,
  deleteInviteCode,
  deleteManagedUser,
  getAdminAgentRun,
  getAdminAgentRunTrace,
  getAdminSummary,
  listAdminAgentRuns,
  listAdminUsers,
  listAdminWorkspaces,
  listInviteCodes,
  updateInviteCodeStatus,
  updateManagedUserRole,
} from "../../../application/admin/admin-application.service.js";
import { USER_ROLES } from "../../../modules/identity/index.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = Router();
const inviteCodeSchema = z.object({
  code: z.string().min(1),
  description: z.string().optional(),
});
const roleUpdateSchema = z.object({ role: z.enum(["teacher", "ta", "student"]) });
const adminStatusSchema = z.object({ isActive: z.boolean() });

/**
 * 功能：处理 USE <middleware> 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.use(requireAuth, requireRoles(USER_ROLES.superAdmin));

/**
 * 功能：处理 GET /summary 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/summary", async (_request, response, next) => {
  try {
    response.json(await getAdminSummary());
  } catch (error) {
    next(error);
  }
});

/**
 * 功能：处理 GET /users 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/users", async (_request, response, next) => {
  try {
    response.json({ users: await listAdminUsers() });
  } catch (error) {
    next(error);
  }
});

/**
 * 功能：处理 PATCH /users/:userId/role 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.patch("/users/:userId/role", async (request, response, next) => {
  try {
    const parsed = roleUpdateSchema.parse(request.body);
    response.json(await updateManagedUserRole(String(request.params.userId), parsed.role));
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "用户角色修改无效。" });
      return;
    }
    next(error);
  }
});

/** Archive and delete a non-administrator account. */
router.delete("/users/:userId", async (request, response, next) => {
  try {
    response.json(await deleteManagedUser(String(request.params.userId)));
  } catch (error) {
    if (error instanceof Error && error.message === "用户不存在。") {
      response.status(404).json({ message: error.message });
      return;
    }
    if (error instanceof Error && error.message.includes("administrator")) {
      response.status(400).json({ message: error.message });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 GET /invite-codes 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/invite-codes", async (_request, response, next) => {
  try {
    response.json({ inviteCodes: await listInviteCodes() });
  } catch (error) {
    next(error);
  }
});

/**
 * 功能：处理 POST /invite-codes 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/invite-codes", async (request, response, next) => {
  try {
    const parsed = inviteCodeSchema.parse(request.body);
    response.status(201).json({ inviteCode: await createInviteCode(parsed) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "邀请码信息无效。" });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 PATCH /invite-codes/:inviteCodeId/status 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.patch("/invite-codes/:inviteCodeId/status", async (request, response, next) => {
  try {
    const parsed = adminStatusSchema.parse(request.body);
    response.json(
      await updateInviteCodeStatus(String(request.params.inviteCodeId), parsed.isActive),
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "邀请码状态修改无效。" });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 DELETE /invite-codes/:inviteCodeId 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.delete("/invite-codes/:inviteCodeId", async (request, response, next) => {
  try {
    response.json(await deleteInviteCode(String(request.params.inviteCodeId)));
  } catch (error) {
    if (error instanceof Error && error.message === "邀请码不存在。") {
      response.status(404).json({ message: error.message });
      return;
    }
    if (error instanceof Error && error.message.includes("super administrator")) {
      response.status(400).json({ message: error.message });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 GET /workspaces 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/workspaces", async (_request, response, next) => {
  try {
    response.json({ workspaces: await listAdminWorkspaces() });
  } catch (error) {
    next(error);
  }
});

/**
 * 功能：处理 GET /admins 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.all("/admins", (_request, response) => {
  response.status(410).json({ message: "超级用户由根目录 superuser.toml 统一管理。" });
});

/**
 * 功能：处理 POST /admins 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
/**
 * 功能：处理 PATCH /admins/:userId/status 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.all("/admins/:userId/status", (_request, response) => {
  response.status(410).json({ message: "超级用户由根目录 superuser.toml 统一管理。" });
});

/**
 * 功能：处理 PATCH /admins/:userId/password 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.all("/admins/:userId/password", (_request, response) => {
  response.status(410).json({ message: "超级用户由根目录 superuser.toml 统一管理。" });
});

/**
 * 功能：处理 GET /agent-runs 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/agent-runs", async (request, response, next) => {
  try {
    response.json({
      runs: await listAdminAgentRuns(request.auth!.role === USER_ROLES.superAdmin),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 功能：处理 GET /agent-runs/:id 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/agent-runs/:id", async (request, response, next) => {
  try {
    const run = await getAdminAgentRun(
      String(request.params.id),
      request.auth!.role === USER_ROLES.superAdmin,
    );
    if (!run) {
      response.status(404).json({ message: "Agent 运行记录不存在。" });
      return;
    }
    response.json({ run });
  } catch (error) {
    next(error);
  }
});

/**
 * 功能：处理 GET /agent-runs/:id/trace 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/agent-runs/:id/trace", async (request, response, next) => {
  try {
    const trace = await getAdminAgentRunTrace(
      String(request.params.id),
      request.auth!.role === USER_ROLES.superAdmin,
    );
    if (!trace) {
      response.status(404).json({ message: "Agent 运行记录不存在。" });
      return;
    }
    response.json({ trace });
  } catch (error) {
    next(error);
  }
});

export { router as adminRouter };
