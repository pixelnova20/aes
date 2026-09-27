/**
 * 文件作用：提供后端进程装配层所需的声明和装配。
 * 模块位置：`apps/server/src/app/app.ts`，属于后端进程装配层。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import cors from "cors";
import express from "express";
import morgan from "morgan";

import { authRouter } from "../transport/http/routes/auth.router.js";
import { workspaceRouter } from "../transport/http/routes/workspace.router.js";
import { aiRouter } from "../transport/http/routes/ai.router.js";
import { agentRouter } from "../transport/http/agent.router.js";
import { codeNavRouter } from "../transport/http/routes/code-navigation.router.js";
import { teacherRouter } from "../transport/http/routes/teacher.router.js";
import { adminRouter } from "../transport/http/routes/admin.router.js";
import { homeworksRouter } from "../transport/http/routes/homeworks.router.js";
import { logsRouter } from "../transport/http/routes/logs.router.js";
import { studentRouter } from "../transport/http/routes/student.router.js";
import { serviceSsoRouter } from "../transport/http/routes/service-sso.router.js";
import { isLogViewerEnabled, logHttp } from "../infrastructure/logging/logger.js";
import { errorHandler } from "../transport/http/middleware/error-handler.js";
import { notFoundHandler } from "../transport/http/middleware/not-found.js";
import { readPiSessionHistory } from "../modules/coding-agent/index.js";
import { configureAgentConversationHistoryReader } from "../modules/conversations/index.js";

// 整个后端 HTTP 应用的装配点：
// 只负责挂中间件、挂路由，不承载具体业务逻辑。
export const app = express();

configureAgentConversationHistoryReader(readPiSessionHistory);

/**
 * 功能：处理 USE <middleware> 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
app.use(cors());
/**
 * 功能：处理 USE <middleware> 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
app.use(express.json({ limit: "16mb" }));

// HTTP 请求日志：调试模式记录所有请求，常规模式只记录错误
/**
 * 功能：处理 USE <middleware> 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
app.use(
  morgan((tokens, req, res) => {
    const status = Number(tokens.status(req, res) ?? 0);
    const ms = Number(tokens["response-time"](req, res) ?? 0);
    const method = tokens.method(req, res) ?? "-";
    const url = tokens.url(req, res) ?? "-";
    const email = (req as any).auth?.email ?? "—";
    if (isLogViewerEnabled()) {
      logHttp(email, method, url, status, ms);
    }
    if (status >= 400) {
      return `${method} ${url} ${status} - ${ms}ms`;
    }
    return null;
  })
);

/**
 * 功能：处理 GET /api/health 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

// 各业务域路由统一从这里挂载，方便按模块定位入口。
/**
 * 功能：处理 USE /api/auth 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
app.use("/api/auth", authRouter);
/**
 * 功能：处理 USE /api/workspace 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
app.use("/api/workspace", workspaceRouter);
/**
 * 功能：处理 USE /api/workspace/code-nav 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
app.use("/api/workspace/code-nav", codeNavRouter);
/**
 * 功能：处理 USE /api/ai 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
app.use("/api/ai", aiRouter);
/**
 * 功能：处理 USE /api/agent 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
app.use("/api/agent", agentRouter);
/**
 * 功能：处理 USE /api/teacher 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
app.use("/api/teacher", teacherRouter);
/**
 * 功能：处理 USE /api/admin 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
app.use("/api/admin", adminRouter);
app.use("/api/homeworks", homeworksRouter);
app.use("/api/services", serviceSsoRouter);
app.use("/api/student", studentRouter);
/**
 * 功能：处理 USE /api/logs 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
app.use("/api/logs", logsRouter);

/**
 * 功能：处理 USE <middleware> 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
app.use(notFoundHandler);
/**
 * 功能：处理 USE <middleware> 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
app.use(errorHandler);
