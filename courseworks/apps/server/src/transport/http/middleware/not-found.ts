/**
 * 文件作用：实现后端 HTTP 协议适配层中的 `notFoundHandler` 等能力。
 * 模块位置：`apps/server/src/transport/http/middleware/not-found.ts`，属于后端 HTTP 协议适配层。
 * 重要函数：`notFoundHandler()` 负责处理`not` `found` `handler`。
 */
import type { Request, Response } from "express";

/**
 * 功能：处理`not` `found` `handler`。
 * 输入：`_request`（Request）提供请求。 `response`（Response）提供响应。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用。
 */
export function notFoundHandler(_request: Request, response: Response) {
  response.status(404).json({ message: "请求的资源不存在。" });
}
