/**
 * 文件作用：实现后端“AI Provider 与模型设置”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/ai-settings/model-capability.service.ts`，属于后端“AI Provider 与模型设置”业务模块。
 * 重要函数：`normalizeProviderBaseUrl()` 负责规范化Provider `base` `url`；`modelFamily()` 负责处理模型 `family`；`isReasoningModel()` 负责判断是否为`reasoning` 模型；`modelCompat()` 负责处理模型 `compat`；`resolveModelCapabilities()` 负责解析并确定模型 `capabilities`；`buildProviderTestRequest()` 负责构建Provider `test` 请求。
 */
import {
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  findSeedModelProfileByName,
} from "./model-profile.service.js";
import {
  findPiModelMetadata,
  type PiModelMetadata,
  type PiThinkingLevelMap,
} from "./models-dev-catalog.js";

export type OpenAICompatibleModelOptions = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsStrictMode?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?: "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen";
};

export type ModelFamily =
  | "deepseek"
  | "zai"
  | "qwen"
  | "moonshot"
  | "minimax"
  | "openai"
  | "generic";

export const REASONING_EFFORTS = [
  "default",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export type ModelCapabilities = {
  family: ModelFamily;
  reasoning: boolean;
  supportsImages: boolean;
  reasoningEffortOptions: readonly ReasoningEffort[];
  thinkingLevelMap: PiThinkingLevelMap;
  thinkingLevel: "off" | Exclude<ReasoningEffort, "default">;
  contextWindowTokens: number;
  effectiveInputTokens: number;
  operationalContextWindowTokens: number;
  compactionTriggerTokens: number;
  compactionReserveTokens: number;
  compactionKeepRecentTokens: number;
  maxTokens: number;
  compat: OpenAICompatibleModelOptions;
};

/**
 * 功能：规范化Provider `base` `url`。
 * 输入：`baseUrl`（string）提供base url。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/ai-settings/ai-settings-application.service.ts:updateAiSettings()`、`apps/server/src/modules/ai-settings/model-capability.service.test.ts 顶层流程`、`apps/server/src/modules/ai-settings/provider-connectivity.service.ts:runProviderRequest()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:createPiSession()` 和 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:compact()` 调用。
 */
export function normalizeProviderBaseUrl(baseUrl: string) {
  const value = baseUrl.trim();
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? value
    : `https://${value}`;
  const url = new URL(withProtocol);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL 必须使用 HTTP 或 HTTPS。");
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/i, "") + "/v1";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

/**
 * 功能：处理模型 `family`。
 * 输入：`model`（string）提供模型。
 * 输出：返回 ModelFamily，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/ai-settings/model-capability.service.ts:resolveModelCapabilities()` 调用；内部调用 `toLowerCase()`、`includes()`、`test()`。
 */
function modelFamily(model: string): ModelFamily {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes("deepseek")) return "deepseek";
  if (/(^|[/_-])(glm|z1)([\d./_-]|$)/i.test(normalized)) return "zai";
  if (normalized.includes("qwen")) return "qwen";
  if (normalized.includes("kimi") || normalized.includes("moonshot")) return "moonshot";
  if (normalized.includes("minimax")) return "minimax";
  if (/(^|[/_-])(gpt|o1|o3|o4)([\d./_-]|$)/i.test(normalized)) return "openai";
  return "generic";
}

/**
 * 功能：判断是否为`reasoning` 模型。
 * 输入：`model`（string）提供模型。 `family`（ModelFamily）提供family。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/ai-settings/model-capability.service.ts:resolveModelCapabilities()` 调用；内部调用 `toLowerCase()`、`test()`、`includes()`。
 */
function isReasoningModel(model: string, family: ModelFamily) {
  const normalized = model.trim().toLowerCase();
  if (family === "deepseek") {
    return !/(^|[-_/])(chat|v3)([-_/]|$)/i.test(normalized)
      || /(^|[-_/])(r1|reasoner|reasoning)([-_/]|$)/i.test(normalized);
  }
  if (family === "zai") return /(^|[-_/])(glm-(4\.[5-9]|[5-9])|z1)([\d._/-]|$)/i.test(normalized);
  if (family === "qwen") return normalized.includes("thinking") || normalized.includes("qwen3");
  if (family === "moonshot") return /k2\.[5-9]|thinking|reason/i.test(normalized);
  if (family === "minimax") return /(^|[-_/])m[2-9]([\d._/-]|$)|reason/i.test(normalized);
  if (family === "openai") return /(^|[/_-])(o1|o3|o4|gpt-5|gpt-oss)([\d.:/_-]|$)/i.test(normalized);
  return /(^|[-_/])(reasoning|reasoner|r1|thinking)([-_/]|$)/i.test(normalized);
}

/**
 * 功能：处理模型 `compat`。
 * 输入：`family`（ModelFamily）提供family。
 * 输出：返回 OpenAICompatibleModelOptions，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/ai-settings/model-capability.service.ts:resolveModelCapabilities()` 调用。
 */
function baseModelCompat(family: ModelFamily): OpenAICompatibleModelOptions {
  const shared: OpenAICompatibleModelOptions = {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsStrictMode: false,
  };
  if (family === "deepseek") {
    return {
      ...shared,
      maxTokensField: "max_completion_tokens",
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
    };
  }
  if (family === "zai") {
    return {
      ...shared,
      maxTokensField: "max_completion_tokens",
      supportsReasoningEffort: false,
      thinkingFormat: "zai",
    };
  }
  if (family === "qwen") {
    return {
      ...shared,
      maxTokensField: "max_tokens",
      supportsReasoningEffort: false,
      thinkingFormat: "qwen",
    };
  }
  if (family === "moonshot" || family === "minimax" || family === "generic") {
    return { ...shared, maxTokensField: "max_tokens" };
  }
  return {
    ...shared,
    maxTokensField: "max_completion_tokens",
    supportsReasoningEffort: true,
    thinkingFormat: "openai",
  };
}

function modelCompat(
  family: ModelFamily,
  metadata?: PiModelMetadata | null,
): OpenAICompatibleModelOptions {
  const fallback = metadata?.providerId === "openrouter"
    ? { ...baseModelCompat(family), maxTokensField: "max_tokens" as const }
    : baseModelCompat(family);
  if (metadata?.api !== "openai-completions" || !metadata.compat) return fallback;
  return { ...fallback, ...metadata.compat };
}

/** Return the effort options Courseworks can safely expose for a model. */
export function reasoningEffortOptionsForModel(
  model: string,
  baseUrl?: string | null,
): readonly ReasoningEffort[] {
  const family = modelFamily(model);
  const metadata = findPiModelMetadata(model, baseUrl);
  if (!metadata?.reasoning || modelCompat(family, metadata).supportsReasoningEffort === false) {
    return ["default"];
  }
  return REASONING_EFFORTS.filter((effort) =>
    effort === "default" || typeof metadata.thinkingLevelMap[effort] === "string",
  );
}

/** Keep persisted or submitted effort values compatible with the selected model. */
export function normalizeReasoningEffortForModel(
  model: string,
  effort?: string | null,
  baseUrl?: string | null,
): ReasoningEffort {
  const requested = REASONING_EFFORTS.find((candidate) => candidate === effort) ?? "default";
  return reasoningEffortOptionsForModel(model, baseUrl).includes(requested) ? requested : "default";
}

/**
 * 功能：解析并确定模型 `capabilities`。
 * 输入：`input`（{ model: string; contextWindowTokens?: number | null; }）提供当前操作所需的结构化输入。
 * 输出：返回 ModelCapabilities，供调用方继续处理。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:resolveAgentContextUsage()`、`apps/server/src/application/ai-settings/ai-settings-application.service.ts:getAiModelProfile()`、`apps/server/src/application/ai-settings/ai-settings-application.service.ts:runDirectAiChat()`、`apps/server/src/modules/ai-settings/model-capability.service.test.ts 顶层流程`、`apps/server/src/modules/ai-settings/model-capability.service.ts:buildProviderTestRequest()` 调用；内部调用 `findPiModelMetadata()`、`findSeedModelProfileByName()`、`modelFamily()`、`max()`、`min()`、`floor()`。
 */
export function resolveModelCapabilities(input: {
  model: string;
  baseUrl?: string | null;
  contextWindowTokens?: number | null;
  reasoningEffort?: ReasoningEffort | null;
}): ModelCapabilities {
  const piMetadata = findPiModelMetadata(input.model, input.baseUrl);
  const fallbackProfile = piMetadata ? null : findSeedModelProfileByName(input.model);
  const family = modelFamily(input.model);
  const catalogContextWindowTokens = piMetadata?.contextWindowTokens
    ?? fallbackProfile?.contextWindowTokens;
  const contextWindowTokens = Math.max(
    8_192,
    input.contextWindowTokens
      ? input.contextWindowTokens
      : catalogContextWindowTokens ?? FALLBACK_CONTEXT_WINDOW_TOKENS,
  );
  const effectiveInputTokens = Math.min(
    contextWindowTokens,
    fallbackProfile?.effectiveInputTokens ?? contextWindowTokens,
  );
  const maxTokens = Math.min(
    32_768,
    Math.max(4_096, Math.floor(contextWindowTokens / 4)),
    piMetadata?.maxOutputTokens ?? Number.POSITIVE_INFINITY,
    Math.floor(contextWindowTokens / 2),
  );
  const compactionReserveTokens = Math.min(
    Math.floor(contextWindowTokens / 2),
    Math.max(4_096, maxTokens),
  );
  const preferredTrigger = Math.max(4_096, Math.floor(effectiveInputTokens * 0.85));
  const outputAwareTrigger = Math.max(4_096, contextWindowTokens - maxTokens);
  const operationalContextWindowTokens = Math.max(
    8_192,
    Math.min(contextWindowTokens, Math.min(preferredTrigger, outputAwareTrigger) + compactionReserveTokens),
  );
  const compactionTriggerTokens = Math.max(
    4_096,
    operationalContextWindowTokens - compactionReserveTokens,
  );
  const compactionKeepRecentTokens = Math.min(
    24_000,
    Math.max(4_096, Math.floor(compactionTriggerTokens / 4)),
  );
  const reasoning = piMetadata?.reasoning ?? isReasoningModel(input.model, family);
  const supportsImages = supportsImageInput(input.model, family, input.baseUrl);
  const reasoningEffortOptions = reasoningEffortOptionsForModel(input.model, input.baseUrl);
  const reasoningEffort = reasoningEffortOptions.includes(input.reasoningEffort ?? "default")
    ? input.reasoningEffort ?? "default"
    : "default";
  const defaultThinkingLevel = piMetadata
    ? (["medium", "high", "low", "minimal", "xhigh", "max"] as const)
      .find((level) => typeof piMetadata.thinkingLevelMap[level] === "string") ?? "off"
    : reasoning && family !== "zai" ? "medium" : "off";
  const thinkingLevel = reasoningEffort !== "default" ? reasoningEffort : defaultThinkingLevel;

  return {
    family,
    reasoning,
    supportsImages,
    reasoningEffortOptions,
    thinkingLevelMap: piMetadata?.thinkingLevelMap ?? {},
    thinkingLevel,
    contextWindowTokens,
    effectiveInputTokens,
    operationalContextWindowTokens,
    compactionTriggerTokens,
    compactionReserveTokens,
    compactionKeepRecentTokens,
    maxTokens,
    compat: modelCompat(family, piMetadata),
  };
}

/** Only enable direct image input for recognizable vision model families. */
function supportsImageInput(model: string, family: ModelFamily, baseUrl?: string | null) {
  const normalized = model.trim().toLowerCase();
  if (normalized.includes("gpt-oss")) return false;
  if (/(^|[/_.:-])(vl|vision)([/_.:-]|$)/i.test(normalized)) return true;
  if (/(^|[/_.:-])(gemini|claude|pixtral)([/_.:-]|$)/i.test(normalized)) return true;
  if (family === "openai") {
    return /(^|[/_.:-])gpt-(4o|4\.1|5)([/_.:-]|$)/i.test(normalized)
      || /(^|[/_.:-])o[134]([/_.:-]|$)/i.test(normalized);
  }
  if (family === "qwen") return /(?:vl|vision)/i.test(normalized);
  if (family === "zai") return /(^|[/_.:-])glm-[^/_.:-]*v/i.test(normalized);
  // A custom endpoint may expose an OpenAI-compatible vision model under a normal ID.
  return Boolean(baseUrl && /openrouter|api\.openai\.com/i.test(baseUrl) && /vision|vl/i.test(normalized));
}

/**
 * 功能：构建Provider `test` 请求。
 * 输入：`model`（string）提供模型。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/ai-settings/model-capability.service.test.ts 顶层流程` 和 `apps/server/src/modules/ai-settings/provider-connectivity.service.ts:testAiProvider()` 调用；内部调用 `resolveModelCapabilities()`。
 */
export function buildProviderTestRequest(
  model: string,
  effort: ReasoningEffort = "default",
  baseUrl?: string | null,
) {
  const reasoningEffort = normalizeReasoningEffortForModel(model, effort, baseUrl);
  const capabilities = resolveModelCapabilities({ model, baseUrl, reasoningEffort });
  const request: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: "Reply with OK only." }],
    temperature: 0,
  };
  request[capabilities.compat.maxTokensField ?? "max_tokens"] = 64;
  if (reasoningEffort !== "default") {
    const mappedEffort = capabilities.thinkingLevelMap[reasoningEffort] ?? reasoningEffort;
    if (capabilities.compat.thinkingFormat === "openrouter") {
      request.reasoning = { effort: mappedEffort };
    } else {
      request.reasoning_effort = mappedEffort;
    }
  }
  if (capabilities.reasoning) {
    if (capabilities.compat.thinkingFormat === "zai" || capabilities.compat.thinkingFormat === "deepseek") {
      request.thinking = { type: reasoningEffort === "default" ? "disabled" : "enabled" };
    } else if (capabilities.compat.thinkingFormat === "qwen") {
      request.enable_thinking = reasoningEffort !== "default";
    }
  }
  return request;
}
