/**
 * 文件作用：实现后端 HTTP 协议适配层中的 `errorHandler` 等能力。
 * 模块位置：`apps/server/src/transport/http/middleware/error-handler.ts`，属于后端 HTTP 协议适配层。
 * 重要函数：`errorHandler()` 负责处理错误信息 `handler`。
 */
import type { NextFunction, Request, Response } from "express";

/**
 * 功能：处理错误信息 `handler`。
 * 输入：`error`（unknown）提供错误信息。 `_request`（Request）提供请求。 `response`（Response）提供响应。 `_next`（NextFunction）提供next。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `error()`。
 */
export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction
) {
  console.error(error instanceof Error ? error.message : "Unexpected error.");
  const clientStatus = error instanceof Error
    && "status" in error
    && typeof error.status === "number"
    && error.status >= 400
    && error.status < 500
    ? error.status
    : null;
  response.status(clientStatus ?? 500).json({
    message: clientStatus && error instanceof Error ? error.message : "服务器内部错误。"
  });
}
