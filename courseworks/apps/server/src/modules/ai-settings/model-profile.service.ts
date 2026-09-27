/**
 * 文件作用：实现后端“AI Provider 与模型设置”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/ai-settings/model-profile.service.ts`，属于后端“AI Provider 与模型设置”业务模块。
 * 重要函数：`normalizeModelName()` 负责规范化模型 `name`；`findSeedModelProfileByName()` 负责查找`seed` 模型 模型档案 `by` `name`；`findPiModelProfileByName()` 负责查找Pi 模型 模型档案 `by` `name`；`aliasesOf()` 负责处理`aliases` `of`；`findModelProfileByName()` 负责查找模型 模型档案 `by` `name`；`resolveContextWindowTokens()` 负责解析并确定上下文 `window` Token 数量；`seedModelProfiles()` 负责处理`seed` 模型 `profiles`。
 */
import type { Prisma, PrismaClient } from "@prisma/client";

import { prisma } from "../../infrastructure/prisma/client.js";
import { LOCAL_MODEL_SOURCE_URL } from "./local-model-catalog.service.js";
import { findPiModelMetadata } from "./models-dev-catalog.js";

// 这里维护“模型名 -> 经验 context window”的平台知识表，
// 目的是把学生不熟悉的上下文窗口参数隐藏在平台内部。
type PrismaLike = PrismaClient | Prisma.TransactionClient;

export type ModelProfileSeed = {
  // 一条模型档案会保留官方名、别名、经验窗口和来源说明。
  providerName?: string;
  modelName: string;
  aliases?: string[];
  contextWindowTokens: number;
  effectiveInputTokens?: number;
  sourceUrl?: string;
  sourceNote?: string;
};

export const FALLBACK_CONTEXT_WINDOW_TOKENS = 128_000;

// 内置 seed 代表平台当前认可的一组模型经验值。
export const MODEL_PROFILE_SEEDS: ModelProfileSeed[] = [
  {
    providerName: "DeepSeek",
    modelName: "DeepSeek-V4-Pro",
    aliases: ["deepseek-v4-pro", "DeepSeek V4 Pro"],
    contextWindowTokens: 1_000_000,
    effectiveInputTokens: 512_000,
    sourceUrl: "https://www.deepseek.com/",
    sourceNote: "Public DeepSeek V4 reports list V4-Pro/Flash as 1M-token context. Effective budget is intentionally conservative."
  },
  {
    providerName: "DeepSeek",
    modelName: "DeepSeek-V4-Flash",
    aliases: ["deepseek-v4-flash", "DeepSeek V4 Flash"],
    contextWindowTokens: 1_000_000,
    effectiveInputTokens: 512_000,
    sourceUrl: "https://www.deepseek.com/",
    sourceNote: "Public DeepSeek V4 reports list V4-Pro/Flash as 1M-token context. Effective budget is intentionally conservative."
  },
  {
    providerName: "DeepSeek",
    modelName: "DeepSeek-V3.2",
    aliases: ["DeepSeek-V3.2-Instruct", "DeepSeek-V3.2-Exp", "DeepSeek-V3.1", "DeepSeek-V3.1-Terminus", "DeepSeek-V3-250324", "DeepSeek-R1", "DeepSeek-R1-0528"],
    contextWindowTokens: 128_000,
    effectiveInputTokens: 96_000,
    sourceUrl: "https://www.deepseek.com/",
    sourceNote: "DeepSeek V3/R1 family profile. Verify exact routed-provider limits before production."
  },
  {
    providerName: "Alibaba Cloud",
    modelName: "Qwen3-Coder-480B-A35B-Instruct",
    aliases: ["Qwen3-Coder-Plus"],
    contextWindowTokens: 262_144,
    effectiveInputTokens: 192_000,
    sourceUrl: "https://qwen.ai/",
    sourceNote: "Qwen coder family profile. Routed providers may expose smaller limits."
  },
  {
    providerName: "Alibaba Cloud",
    modelName: "Qwen3-235B-A22B-Instruct-2507",
    aliases: ["Qwen3-235B-A22B", "Qwen3-235B-A22B-Thinking-2507", "Qwen3-VL-235B-A22B-Instruct", "Qwen3-VL-235B-A22B-Thinking"],
    contextWindowTokens: 262_144,
    effectiveInputTokens: 192_000,
    sourceUrl: "https://qwen.ai/",
    sourceNote: "Qwen3 235B/VL long-context family profile."
  },
  {
    providerName: "Alibaba Cloud",
    modelName: "Qwen3-Next-80B-A3B-Instruct",
    aliases: ["Qwen3-Next-80B-A3B-Thinking"],
    contextWindowTokens: 262_144,
    effectiveInputTokens: 192_000,
    sourceUrl: "https://qwen.ai/",
    sourceNote: "Qwen3-Next family profile."
  },
  {
    providerName: "Alibaba Cloud",
    modelName: "Qwen3-30B-A3B-Instruct-2507",
    aliases: ["Qwen3-30B-A3B-Thinking-2507", "Qwen3-VL-30B-A3B-Instruct", "Qwen3-VL-30B-A3B-Thinking", "Qwen3-32B"],
    contextWindowTokens: 131_072,
    effectiveInputTokens: 96_000,
    sourceUrl: "https://qwen.ai/",
    sourceNote: "Qwen3 30B/32B family profile."
  },
  {
    providerName: "Alibaba Cloud",
    modelName: "Qwen-Long",
    aliases: ["GLM-4-Long"],
    contextWindowTokens: 1_000_000,
    effectiveInputTokens: 512_000,
    sourceNote: "Long-context routed model profile. Verify exact provider endpoint limits before production."
  },
  {
    providerName: "Alibaba Cloud",
    modelName: "Qwen3.5-Plus",
    aliases: ["Qwen3.6-Plus", "Qwen3.5-27B", "Qwen3.5-35B-A3B", "Qwen3.5-122B-A10B", "Qwen3.5-397B-A17B", "Qwen3.7-Max"],
    contextWindowTokens: 262_144,
    effectiveInputTokens: 192_000,
    sourceUrl: "https://qwen.ai/",
    sourceNote: "Qwen3.5/3.6 family profile."
  },
  {
    providerName: "Zhipu/Z.ai",
    modelName: "GLM-4.5",
    aliases: ["GLM-4.5-Air", "GLM-4.5-AirX", "GLM-4.5-Flash", "GLM-4.5V", "GLM-4.6", "GLM-4.6V", "GLM-4.7"],
    contextWindowTokens: 128_000,
    effectiveInputTokens: 96_000,
    sourceUrl: "https://github.com/zai-org/GLM-4.5",
    sourceNote: "GLM-4.5+ family profile. Verify routed-provider limits before production."
  },
  {
    providerName: "Zhipu/Z.ai",
    modelName: "GLM-4-Plus",
    aliases: ["GLM-4-Air", "GLM-4-Flash", "GLM-4-FlashX", "GLM-4V", "GLM-4V-Flash", "GLM-4V-Plus-0111", "GLM-Z1-Air", "GLM-Z1-AirX", "GLM-Z1-Flash"],
    contextWindowTokens: 128_000,
    effectiveInputTokens: 96_000,
    sourceUrl: "https://open.bigmodel.cn/",
    sourceNote: "GLM-4 family profile."
  },
  {
    providerName: "Zhipu/Z.ai",
    modelName: "GLM-5",
    aliases: ["GLM-5.1", "GLM-5.2", "GLM-5-Turbo"],
    contextWindowTokens: 128_000,
    effectiveInputTokens: 96_000,
    sourceUrl: "https://open.bigmodel.cn/",
    sourceNote: "GLM-5 family profile. Verify exact provider limits before production."
  },
  {
    providerName: "Moonshot AI",
    modelName: "Kimi-K2.5",
    aliases: ["Kimi-K2.6"],
    contextWindowTokens: 256_000,
    effectiveInputTokens: 192_000,
    sourceUrl: "https://platform.moonshot.ai/",
    sourceNote: "Kimi K2.5/K2.6 family profile."
  },
  {
    providerName: "MiniMax",
    modelName: "MiniMax-Text-01",
    aliases: ["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5", "MiniMax-M2"],
    contextWindowTokens: 1_000_000,
    effectiveInputTokens: 512_000,
    sourceUrl: "https://www.minimaxi.com/",
    sourceNote: "MiniMax long-context family profile. Conservative effective budget."
  },
  {
    providerName: "MiniMax",
    modelName: "MiniMax-M1-80k",
    aliases: ["MiniMax-I2V-01", "MiniMax-I2V-01-Live", "MiniMax-I2V-01-Director", "MiniMax-T2V-01", "MiniMax-T2V-01-Director", "MiniMax-Hailuo-02"],
    contextWindowTokens: 80_000,
    effectiveInputTokens: 60_000,
    sourceUrl: "https://www.minimaxi.com/",
    sourceNote: "MiniMax routed/media model fallback profile."
  },
  {
    providerName: "Baidu",
    modelName: "ERNIE-4.5-Turbo-128K",
    aliases: ["ERNIE-5.0-Thinking-Preview"],
    contextWindowTokens: 128_000,
    effectiveInputTokens: 96_000,
    sourceUrl: "https://cloud.baidu.com/",
    sourceNote: "ERNIE long-context profile."
  },
  {
    providerName: "Baidu",
    modelName: "ERNIE-4.5-Turbo-32K",
    aliases: ["ERNIE-4.5-Turbo-VL-32K"],
    contextWindowTokens: 32_000,
    effectiveInputTokens: 24_000,
    sourceUrl: "https://cloud.baidu.com/",
    sourceNote: "ERNIE 32K family profile."
  },
  {
    providerName: "Baichuan",
    modelName: "Baichuan-M2-128K",
    aliases: ["Baichuan-M2", "Baichuan-M3"],
    contextWindowTokens: 128_000,
    effectiveInputTokens: 96_000,
    sourceUrl: "https://platform.baichuan-ai.com/",
    sourceNote: "Baichuan family profile."
  },
  {
    providerName: "ByteDance/Volcengine",
    modelName: "Doubao-Seed-1.6",
    aliases: ["Doubao-1.5-pro", "Doubao-Seedance-1.0-Pro"],
    contextWindowTokens: 128_000,
    effectiveInputTokens: 96_000,
    sourceUrl: "https://www.volcengine.com/product/doubao",
    sourceNote: "Doubao text/model family profile. Seedream/Seedance media models are not ideal chat models."
  }
];

/**
 * 功能：规范化模型 `name`。
 * 输入：`model`（string）提供模型。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/ai-settings/model-profile.service.ts:findSeedModelProfileByName()`、`apps/server/src/modules/ai-settings/model-profile.service.ts:findModelProfileByName()` 调用；内部调用 `replace()`、`toLowerCase()`。
 */
export function normalizeModelName(model: string) {
  // 名称匹配统一先做归一化，降低大小写和分隔符差异带来的影响。
  return model.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

/**
 * 功能：查找`seed` 模型 模型档案 `by` `name`。
 * 输入：`model`（string）提供模型。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/ai-settings/model-capability.service.ts:resolveModelCapabilities()` 调用；内部调用 `normalizeModelName()`、`find()`、`some()`。
 */
export function findSeedModelProfileByName(model: string) {
  const normalized = normalizeModelName(model);
  if (!normalized) return null;
  return MODEL_PROFILE_SEEDS.find((profile) =>
    [profile.modelName, ...(profile.aliases ?? [])]
      .some((name) => normalizeModelName(name) === normalized),
  ) ?? null;
}

/**
 * 功能：查找Pi 模型 模型档案 `by` `name`。
 * 输入：`model`（string）提供模型。
 * 输出：返回 ModelProfileSeed | null，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/ai-settings/model-profile.service.ts:findModelProfileByName()` 调用；内部调用 `findPiModelMetadata()`、`toISOString()`。
 */
export function findPiModelProfileByName(
  model: string,
  baseUrl?: string | null,
): ModelProfileSeed | null {
  const metadata = findPiModelMetadata(model, baseUrl);
  if (!metadata) return null;
  return {
    providerName: metadata.providerName,
    modelName: metadata.modelName,
    aliases: [model],
    contextWindowTokens: metadata.contextWindowTokens,
    sourceUrl: "https://models.dev/",
    sourceNote: metadata.generatedAt
      ? `Loaded from Pi's models.dev catalog generated at ${new Date(metadata.generatedAt).toISOString()}.`
      : "Loaded from Pi's models.dev catalog.",
  };
}

/**
 * 功能：处理`aliases` `of`。
 * 输入：`profile`（{ aliases: unknown }）提供模型档案。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/ai-settings/model-profile.service.ts:findModelProfileByName()` 调用；内部调用 `isArray()`。
 */
function aliasesOf(profile: { aliases: unknown }) {
  return Array.isArray(profile.aliases) ? profile.aliases.filter((value): value is string => typeof value === "string") : [];
}

/**
 * 功能：查找模型 模型档案 `by` `name`。
 * 输入：`model`（string）提供模型。 `client`（PrismaLike）提供client。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/ai-settings/ai-settings-application.service.ts:getAiModelProfile()`、`apps/server/src/modules/ai-settings/model-profile.service.ts:resolveContextWindowTokens()` 调用；内部调用 `normalizeModelName()`、`findMany()`、`aliasesOf()`、`some()`、`find()`、`findPiModelProfileByName()`。
 */
export async function findModelProfileByName(
  model: string,
  client: PrismaLike = prisma,
  baseUrl?: string | null,
) {
  // 通过官方名或 alias 做精确归一化匹配。
  const normalized = normalizeModelName(model);
  if (!normalized) return null;
  const profiles = await client.aiModelProfile.findMany({
    where: { isActive: true },
    orderBy: { modelName: "asc" }
  });
  const matchingProfiles = profiles.filter((profile) => {
    const names = [profile.modelName, ...aliasesOf(profile)];
    return names.some((name) => normalizeModelName(name) === normalized);
  });
  const localProfile = matchingProfiles.find((profile) => profile.sourceUrl === LOCAL_MODEL_SOURCE_URL);
  if (localProfile) return localProfile;

  const piProfile = findPiModelProfileByName(model, baseUrl);
  return piProfile ?? matchingProfiles[0] ?? null;
}

/**
 * 功能：解析并确定上下文 `window` Token 数量。
 * 输入：`model`（string）提供模型。`configuredContextWindowTokens` 是用户或部署显式配置的上限。`client`（PrismaLike）提供client。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:submitAgentPrompt()`、`apps/server/src/application/agent/agent-application.service.ts:resolveAgentContextUsage()`、`apps/server/src/application/agent/agent-application.service.ts:compactAgentChat()`、`apps/server/src/application/ai-settings/ai-settings-application.service.ts:getAiSettings()`、`apps/server/src/application/ai-settings/ai-settings-application.service.ts:updateAiSettings()` 调用；内部调用 `findModelProfileByName()`。
 */
export async function resolveContextWindowTokens(
  model: string,
  configuredContextWindowTokens?: number,
  client: PrismaLike = prisma,
  baseUrl?: string | null,
) {
  if (configuredContextWindowTokens !== undefined) return configuredContextWindowTokens;
  const profile = await findModelProfileByName(model, client, baseUrl);
  return profile?.contextWindowTokens ?? FALLBACK_CONTEXT_WINDOW_TOKENS;
}

/**
 * 功能：处理`seed` 模型 `profiles`。
 * 输入：`client`（PrismaLike）提供client。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/prisma/seed.ts:main()` 调用；内部调用 `findUnique()`、`upsert()`。
 */
export async function seedModelProfiles(client: PrismaLike = prisma) {
  // seed 过程采用 upsert，便于重复执行和后续增量更新。
  for (const profile of MODEL_PROFILE_SEEDS) {
    const existing = await client.aiModelProfile.findUnique({
      where: { modelName: profile.modelName },
      select: { sourceUrl: true },
    });
    if (existing?.sourceUrl === LOCAL_MODEL_SOURCE_URL) continue;
    await client.aiModelProfile.upsert({
      where: { modelName: profile.modelName },
      create: {
        providerName: profile.providerName,
        modelName: profile.modelName,
        aliases: profile.aliases ?? [],
        contextWindowTokens: profile.contextWindowTokens,
        effectiveInputTokens: profile.effectiveInputTokens,
        sourceUrl: profile.sourceUrl,
        sourceNote: profile.sourceNote
      },
      update: {
        providerName: profile.providerName,
        aliases: profile.aliases ?? [],
        contextWindowTokens: profile.contextWindowTokens,
        effectiveInputTokens: profile.effectiveInputTokens,
        sourceUrl: profile.sourceUrl,
        sourceNote: profile.sourceNote,
        isActive: true
      }
    });
  }
}
