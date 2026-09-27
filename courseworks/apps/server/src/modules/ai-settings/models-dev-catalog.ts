/**
 * 文件作用：实现后端“AI Provider 与模型设置”业务模块中的 `normalizeCatalogName`、`basename`、`matchScore` 等能力。
 * 模块位置：`apps/server/src/modules/ai-settings/models-dev-catalog.ts`，属于后端“AI Provider 与模型设置”业务模块。
 * 重要函数：`normalizeCatalogName()` 负责规范化模型目录 `name`；`basename()` 负责处理`basename`；`matchScore()` 负责处理`match` `score`；`representativeValue()` 负责处理`representative` `value`；`findPiModelMetadata()` 负责查找Pi 模型 `metadata`。
 */
import catalog from "./data/models.dev.json" with { type: "json" };

type ModelsDevEntry = {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  api: string;
  thinkingLevelMap?: PiThinkingLevelMap;
  compat?: PiModelCompat;
};

type ModelsDevProvider = {
  id: string;
  name: string;
  baseUrl?: string;
};

export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type PiThinkingLevel = typeof PI_THINKING_LEVELS[number];
export type PiThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;
export type PiModelCompat = {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsStrictMode?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?: "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen";
};

export type PiModelMetadata = {
  modelName: string;
  providerId: string | null;
  providerName: string;
  contextWindowTokens: number;
  maxOutputTokens: number;
  reasoning: boolean;
  api: string;
  thinkingLevelMap: PiThinkingLevelMap;
  compat?: PiModelCompat;
  generatedAt?: number;
};

const MODELS = catalog.models as readonly ModelsDevEntry[];
const PROVIDERS = catalog.providers as readonly ModelsDevProvider[];
const EXTENDED_THINKING_LEVELS = new Set<PiThinkingLevel>(["xhigh", "max"]);

/**
 * 功能：规范化模型目录 `name`。
 * 输入：`value`（string）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/ai-settings/models-dev-catalog.ts:matchScore()`、`apps/server/src/modules/ai-settings/models-dev-catalog.ts:findPiModelMetadata()` 调用；内部调用 `replace()`、`toLowerCase()`。
 */
function normalizeCatalogName(value: string) {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function normalizeModelId(value: string) {
  return value.trim().toLowerCase();
}

function normalizeBaseUrlForMatch(value: string) {
  try {
    const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(value.trim())
      ? value.trim()
      : `https://${value.trim()}`;
    const url = new URL(withProtocol);
    const pathname = url.pathname
      .replace(/\/+$/, "")
      .replace(/\/v1$/i, "")
      .replace(/\/+$/, "");
    return `${url.protocol}//${url.host.toLowerCase()}${pathname}`;
  } catch {
    return "";
  }
}

/** Resolve a Pi provider only when the configured endpoint identifies it unambiguously. */
export function findPiProviderId(baseUrl?: string | null) {
  if (!baseUrl?.trim()) return null;
  const normalized = normalizeBaseUrlForMatch(baseUrl);
  if (!normalized) return null;
  return PROVIDERS.find((provider) =>
    provider.baseUrl && normalizeBaseUrlForMatch(provider.baseUrl) === normalized,
  )?.id ?? null;
}

/**
 * 功能：处理`basename`。
 * 输入：`value`（string）提供value。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/ai-settings/models-dev-catalog.ts:matchScore()`、`apps/server/src/modules/workspaces/import-export.service.ts:sanitizeArchiveFileName()`、`scripts/check-dependencies.mjs:checkArchitectureBoundaries()` 调用；内部调用 `at()`、`split()`。
 */
function basename(value: string) {
  return value.split("/").at(-1) ?? value;
}

/**
 * 功能：处理`match` `score`。
 * 输入：`requested`（string）提供requested。 `model`（ModelsDevEntry）提供模型。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/ai-settings/models-dev-catalog.ts:findPiModelMetadata()` 调用；内部调用 `normalizeCatalogName()`、`basename()`。
 */
function matchScore(requested: string, model: ModelsDevEntry) {
  const id = normalizeCatalogName(model.id);
  if (id === requested) return 3;
  if (normalizeCatalogName(basename(model.id)) === requested) return 2;
  if (normalizeCatalogName(model.name) === requested) return 1;
  return 0;
}

/**
 * 功能：处理`representative` `value`。
 * 输入：`values`（number[]）提供values。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/ai-settings/models-dev-catalog.ts:findPiModelMetadata()` 调用；内部调用 `sort()`、`entries()`。
 */
function representativeValue(values: number[]) {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([leftValue, leftCount], [rightValue, rightCount]) =>
      rightCount - leftCount || leftValue - rightValue,
    )[0]?.[0];
}

function mappedThinkingLevel(model: ModelsDevEntry, level: PiThinkingLevel) {
  if (!model.reasoning) return null;
  const configured = model.thinkingLevelMap?.[level];
  if (configured === null) return null;
  if (typeof configured === "string") return configured;
  return EXTENDED_THINKING_LEVELS.has(level) ? null : level;
}

function conservativeThinkingLevelMap(models: readonly ModelsDevEntry[]): PiThinkingLevelMap {
  const result: PiThinkingLevelMap = {};
  for (const level of PI_THINKING_LEVELS) {
    const values = models.map((model) => mappedThinkingLevel(model, level));
    const first = values[0];
    result[level] = first !== null && values.every((value) => value === first)
      ? first
      : null;
  }
  return result;
}

function matchingModels(modelName: string, providerId: string | null) {
  const candidates = providerId
    ? MODELS.filter((model) => model.provider === providerId)
    : MODELS;
  const requestedId = normalizeModelId(modelName);
  const exactIdMatches = candidates.filter((model) => normalizeModelId(model.id) === requestedId);
  if (exactIdMatches.length > 0) return exactIdMatches;
  if (!providerId) return [];

  const requestedName = normalizeCatalogName(modelName);
  const scored = candidates.map((model) => ({ model, score: matchScore(requestedName, model) }));
  const bestScore = Math.max(0, ...scored.map(({ score }) => score));
  return scored
    .filter(({ score }) => score > 0 && score === bestScore)
    .map(({ model }) => model);
}

/**
 * 功能：查找Pi 模型 `metadata`。
 * 输入：`modelName`（string）提供模型 name。
 * 输出：返回 PiModelMetadata | null，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/ai-settings/model-capability.service.ts:resolveModelCapabilities()`、`apps/server/src/modules/ai-settings/model-profile.service.ts:findPiModelProfileByName()`、`apps/server/src/modules/ai-settings/pi-model-catalog.test.ts 顶层流程` 调用；内部调用 `normalizeCatalogName()`、`matchScore()`、`max()`、`representativeValue()`、`find()`、`parse()`。
 */
export function findPiModelMetadata(modelName: string, baseUrl?: string | null): PiModelMetadata | null {
  if (!modelName.trim()) return null;
  const providerId = findPiProviderId(baseUrl);
  const matches = matchingModels(modelName, providerId);
  if (matches.length === 0) return null;
  const contextWindowTokens = providerId
    ? representativeValue(matches.map((model) => model.contextWindow))
    : Math.min(...matches.map((model) => model.contextWindow));
  const maxOutputTokens = providerId
    ? representativeValue(matches.map((model) => model.maxTokens))
    : Math.min(...matches.map((model) => model.maxTokens));
  if (!contextWindowTokens || !maxOutputTokens) return null;
  const representative = matches.find((model) =>
    model.contextWindow === contextWindowTokens && model.maxTokens === maxOutputTokens,
  ) ?? matches[0];
  if (!representative) return null;
  const generatedAt = catalog.generatedAt ? Date.parse(catalog.generatedAt) : undefined;
  return {
    modelName: representative.id,
    providerId,
    providerName: providerId
      ? PROVIDERS.find((provider) => provider.id === providerId)?.name ?? providerId
      : "OpenAI-compatible gateway",
    contextWindowTokens,
    maxOutputTokens,
    reasoning: matches.every((model) => model.reasoning),
    api: representative.api,
    thinkingLevelMap: conservativeThinkingLevelMap(matches),
    ...(providerId && representative.compat ? { compat: representative.compat } : {}),
    generatedAt: generatedAt !== undefined && !Number.isNaN(generatedAt) ? generatedAt : undefined,
  };
}
