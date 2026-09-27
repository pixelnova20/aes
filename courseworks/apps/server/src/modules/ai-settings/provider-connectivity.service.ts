/**
 * 文件作用：从 Courseworks 后端直接测试 OpenAI-compatible Provider 并发现模型。
 * 模块位置：`apps/server/src/modules/ai-settings/provider-connectivity.service.ts`，属于后端“AI Provider 与模型设置”业务模块。
 */
import type { AiSettings } from "./ai-settings.types.js";
import { buildProviderTestRequest, normalizeProviderBaseUrl } from "./model-capability.service.js";

const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
const MAX_PROVIDER_RESPONSE_BYTES = 4_000_000;

function providerErrorMessage(status: number, body: string, apiKey: string) {
  if (status === 401 || status === 403) {
    return apiKey
      ? `Provider returned HTTP ${status}: API Key was rejected.`
      : `Provider returned HTTP ${status}: authentication is required.`;
  }
  if (status === 404) return "Provider returned HTTP 404: verify the Base URL and model name.";
  if (status === 429) return "Provider returned HTTP 429: the provider rate limit or account quota was reached.";
  try {
    const parsed = JSON.parse(body);
    const message = String(parsed?.error?.message ?? parsed?.message ?? "")
      .replaceAll(apiKey, "[redacted]")
      .slice(0, 240);
    if (message) return `Provider returned HTTP ${status}: ${message}`;
  } catch { /* Some compatible providers return non-JSON errors. */ }
  return `Provider returned HTTP ${status}. Verify the Base URL, model, and provider settings.`;
}

async function readLimitedResponse(response: Response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error("服务商响应超过 4 MB 安全限制。");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let body = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("服务商响应超过 4 MB 安全限制。");
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

async function runProviderRequest(input: {
  baseUrl: string;
  apiKey?: string;
  method: "GET" | "POST";
  path: "/models" | "/chat/completions";
  requestBody?: string;
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_REQUEST_TIMEOUT_MS);
  try {
    const headers = new Headers({ Accept: "application/json" });
    if (input.apiKey) headers.set("Authorization", `Bearer ${input.apiKey}`);
    if (input.requestBody !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(`${normalizeProviderBaseUrl(input.baseUrl)}${input.path}`, {
      method: input.method,
      headers,
      body: input.requestBody,
      signal: controller.signal,
    });
    return { status: response.status, body: await readLimitedResponse(response) };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("服务商请求在 20 秒后超时。");
    if (error instanceof Error && error.message === "Provider response exceeded the 4 MB safety limit.") throw error;
    const rawDetail = error instanceof Error ? error.message : "unknown network error";
    const detail = input.apiKey
      ? rawDetail.replaceAll(input.apiKey, "[redacted]").slice(0, 240)
      : rawDetail.slice(0, 240);
    throw new Error(`Courseworks 后端无法完成服务商请求：${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

export function parseAiProviderModels(body: string) {
  const parsed: unknown = JSON.parse(body);
  const record = objectRecord(parsed);
  const candidates = Array.isArray(parsed)
    ? parsed
    : Array.isArray(record?.data)
      ? record.data
      : Array.isArray(record?.models)
        ? record.models
        : [];
  const models = candidates
    .map((candidate) => {
      if (typeof candidate === "string") return candidate.trim();
      const item = objectRecord(candidate);
      const value = item?.id ?? item?.name ?? item?.model;
      return typeof value === "string" ? value.trim() : "";
    })
    .filter((model) => model.length > 0);
  return [...new Set(models)].sort((left, right) => left.localeCompare(right));
}

export async function testAiProvider(settings: AiSettings) {
  if (!settings.apiKey.trim() || !settings.baseUrl.trim() || !settings.model.trim()) {
    throw new Error("测试前请填写 Base URL、模型和 API Key。");
  }
  const result = await runProviderRequest({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    method: "POST",
    path: "/chat/completions",
    requestBody: JSON.stringify(buildProviderTestRequest(
      settings.model,
      settings.reasoningEffort ?? "default",
      settings.baseUrl,
    )),
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(providerErrorMessage(result.status, result.body, settings.apiKey));
  }
  return { message: "Courseworks 后端连接成功。" };
}

export async function listAiProviderModels(settings: { baseUrl: string; apiKey?: string }) {
  if (!settings.baseUrl.trim()) throw new Error("加载模型前请输入 Base URL。");
  const result = await runProviderRequest({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    method: "GET",
    path: "/models",
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(providerErrorMessage(result.status, result.body, settings.apiKey ?? ""));
  }
  let models: string[];
  try {
    models = parseAiProviderModels(result.body);
  } catch {
    throw new Error("服务商返回的模型列表响应无效。");
  }
  if (models.length === 0) throw new Error("服务商未返回可选模型。");
  return models;
}
