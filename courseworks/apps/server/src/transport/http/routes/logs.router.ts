/**
 * 文件作用：把 HTTP 请求适配为后端应用层调用，并统一返回协议响应。
 * 模块位置：`apps/server/src/transport/http/routes/logs.router.ts`，属于后端 HTTP 协议适配层。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import { Router } from "express";

import {
  getRecentLogs,
  isLogViewerEnabled,
} from "../../../infrastructure/logging/logger.js";

const router = Router();

/**
 * 功能：处理 GET / 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/", (request, response) => {
  if (!isLogViewerEnabled()) {
    response.status(404).json({ message: "Log viewer is disabled." });
    return;
  }
  const lines = Math.min(Number(request.query.lines) || 200, 500);
  response.json({ lines: getRecentLogs(lines), enabled: true });
});

export { router as logsRouter };
