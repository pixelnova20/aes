/**
 * 文件作用：实现前端共享能力层中的 `apiFetch`、`tryParseJson`、`fallbackHttpErrorMessage` 等能力。
 * 模块位置：`apps/web/src/shared/api/client.ts`，属于前端共享能力层。
 * 重要函数：`apiFetch()` 负责处理`api` `fetch`；`tryParseJson()` 负责处理`try` `parse` `json`；`fallbackHttpErrorMessage()` 负责处理`fallback` `http` 错误信息 消息。
 */
const API_BASE = "/api";

// 所有前端 API 调用都通过这个错误类型把 HTTP 状态码带出来，
// 方便页面按 status 决定提示方式。
export class ApiError extends Error {
  status: number;

  /**
   * 功能：初始化携带 HTTP 状态码的前端 API 错误。
   * 输入：`message`（string）提供消息。 `status`（number）提供状态。
   * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
   * 调用关系：由创建该类实例的代码自动调用。
   */
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type RequestOptions = RequestInit & {
  token?: string | null;
};

/**
 * 功能：处理`api` `fetch`。
 * 输入：`path`（string）提供路径。 `options`（RequestOptions）提供options。
 * 输出：返回 Promise<T>，供调用方继续处理。
 * 调用关系：由 `apps/web/src/features/admin/AdminPage.tsx:loadAll()`、`apps/web/src/features/admin/AdminPage.tsx:createInviteCode()`、`apps/web/src/features/admin/AdminPage.tsx:updateUserRole()`、`apps/web/src/features/admin/AdminPage.tsx:toggleInviteCode()`、`apps/web/src/features/admin/AdminPage.tsx:deleteInviteCode()` 调用；内部调用 `fetch()`、`text()`、`tryParseJson()`、`fallbackHttpErrorMessage()`。
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  // 统一处理 token、JSON 请求体和标准错误解析。
  const headers = new Headers(options.headers ?? {});
  if (!(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  if (options.token) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers
  });

  const text = await response.text();
  const data = text ? tryParseJson(text) : {};
  if (!response.ok) {
    throw new ApiError(data.message ?? fallbackHttpErrorMessage(response.status), response.status);
  }

  return data as T;
}

/**
 * 功能：处理`try` `parse` `json`。
 * 输入：`text`（string）提供text。
 * 输出：返回 any，供调用方继续处理。
 * 调用关系：由 `apps/web/src/shared/api/client.ts:apiFetch()` 调用；内部调用 `parse()`。
 */
function tryParseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * 功能：处理`fallback` `http` 错误信息 消息。
 * 输入：`status`（number）提供状态。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/web/src/shared/api/client.ts:apiFetch()` 调用。
 */
function fallbackHttpErrorMessage(status: number) {
  if (status === 413) return "上传文件过大，超过服务器允许的请求体大小。";
  return "请求失败。";
}
