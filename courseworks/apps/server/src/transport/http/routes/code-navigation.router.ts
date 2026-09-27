/**
 * 文件作用：把 HTTP 请求适配为后端应用层调用，并统一返回协议响应。
 * 模块位置：`apps/server/src/transport/http/routes/code-navigation.router.ts`，属于后端 HTTP 协议适配层。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import { Router } from "express";

import {
  findWorkspaceCodeDefinitions,
  regenerateWorkspaceCodeNavigation,
} from "../../../application/code-navigation/code-navigation-application.service.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = Router();

// POST /api/workspace/code-nav/regenerate — 重建符号索引
/**
 * 功能：处理 POST /regenerate 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/regenerate", requireAuth, requireRoles("teacher", "ta", "student"), async (request, response) => {
  try {
    const regenerated = await regenerateWorkspaceCodeNavigation(request.auth!.userId);
    if (regenerated) {
      response.json({ ok: true, path: ".tags" });
    } else {
      response.status(500).json({ message: "ctags failed" });
    }
  } catch {
    response.status(500).json({ message: "Index rebuild failed." });
  }
});

// GET /api/workspace/definition?file=main.c&line=10&column=5
/**
 * 功能：处理 GET /definition 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/definition", requireAuth, requireRoles("teacher", "ta", "student"), async (request, response) => {
  try {
    const file = String(request.query.file ?? "");
    const word = String(request.query.word ?? "");
    response.json({
      definitions: await findWorkspaceCodeDefinitions(request.auth!.userId, file, word),
    });
  } catch {
    response.status(500).json({ message: "Definition lookup failed." });
  }
});

export { router as codeNavRouter };
