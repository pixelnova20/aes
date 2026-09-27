/**
 * 文件作用：实现后端“AI Provider 与模型设置”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/ai-settings/local-model-catalog.service.ts`，属于后端“AI Provider 与模型设置”业务模块。
 * 重要函数：`prepareLocalModelProfile()` 负责准备`local` 模型 模型档案；`registerLocalModelProfile()` 负责注册`local` 模型 模型档案；`listLocalModelProfiles()` 负责列出`local` 模型 `profiles`；`deactivateLocalModelProfile()` 负责处理`deactivate` `local` 模型 模型档案。
 */
import type { PrismaClient } from "@prisma/client";

import { prisma } from "../../infrastructure/prisma/client.js";

export const LOCAL_MODEL_SOURCE_URL = "courseworks://local-model";

type LocalModelCatalogClient = Pick<PrismaClient, "aiModelProfile">;

export type LocalModelProfileInput = {
  modelName: string;
  providerName?: string;
  contextWindowTokens: number;
  aliases?: string[];
  sourceNote?: string;
};

/**
 * 功能：准备`local` 模型 模型档案。
 * 输入：`input`（LocalModelProfileInput）提供当前操作所需的结构化输入。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/scripts/manage-local-model.ts:addModel()`、`apps/server/src/modules/ai-settings/local-model-catalog.service.test.ts 顶层流程`、`apps/server/src/modules/ai-settings/local-model-catalog.service.ts:registerLocalModelProfile()` 调用；内部调用 `isInteger()`。
 */
export function prepareLocalModelProfile(input: LocalModelProfileInput) {
  const modelName = input.modelName.trim();
  const providerName = input.providerName?.trim() || "Ollama";
  if (!modelName) throw new Error("Model name is required.");
  if (modelName.length > 191) throw new Error("Model name must not exceed 191 characters.");
  if (providerName.length > 128) throw new Error("Provider name must not exceed 128 characters.");
  if (
    !Number.isInteger(input.contextWindowTokens)
    || input.contextWindowTokens < 4_096
    || input.contextWindowTokens > 2_000_000
  ) {
    throw new Error("Context window must be an integer between 4096 and 2000000.");
  }
  const aliases = [...new Set((input.aliases ?? []).map((alias) => alias.trim()))]
    .filter((alias) => alias && alias !== modelName);
  return {
    providerName,
    modelName,
    aliases,
    contextWindowTokens: input.contextWindowTokens,
    effectiveInputTokens: null,
    sourceUrl: LOCAL_MODEL_SOURCE_URL,
    sourceNote: input.sourceNote?.trim() || "Locally registered OpenAI-compatible model.",
    isActive: true,
  };
}

/**
 * 功能：注册`local` 模型 模型档案。
 * 输入：`input`（LocalModelProfileInput）提供当前操作所需的结构化输入。 `client`（LocalModelCatalogClient）提供client。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/scripts/manage-local-model.ts:addModel()`、`apps/server/src/modules/ai-settings/local-model-catalog.service.test.ts 顶层流程` 调用；内部调用 `prepareLocalModelProfile()`、`upsert()`。
 */
export async function registerLocalModelProfile(
  input: LocalModelProfileInput,
  client: LocalModelCatalogClient = prisma,
) {
  const profile = prepareLocalModelProfile(input);
  const { modelName } = profile;
  await client.aiModelProfile.upsert({
    where: { modelName },
    create: profile,
    update: profile,
  });
  return profile;
}

/**
 * 功能：列出`local` 模型 `profiles`。
 * 输入：`client`（LocalModelCatalogClient）提供client。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/scripts/manage-local-model.ts:listModels()` 调用；内部调用 `findMany()`。
 */
export async function listLocalModelProfiles(client: LocalModelCatalogClient = prisma) {
  return client.aiModelProfile.findMany({
    where: { sourceUrl: LOCAL_MODEL_SOURCE_URL, isActive: true },
    orderBy: { modelName: "asc" },
    select: {
      modelName: true,
      providerName: true,
      contextWindowTokens: true,
      aliases: true,
    },
  });
}

/**
 * 功能：处理`deactivate` `local` 模型 模型档案。
 * 输入：`modelName`（string）提供模型 name。 `client`（LocalModelCatalogClient）提供client。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/scripts/manage-local-model.ts:removeModel()`、`apps/server/src/modules/ai-settings/local-model-catalog.service.test.ts 顶层流程` 调用；内部调用 `updateMany()`。
 */
export async function deactivateLocalModelProfile(
  modelName: string,
  client: LocalModelCatalogClient = prisma,
) {
  const normalizedName = modelName.trim();
  if (!normalizedName) throw new Error("Model name is required.");
  const result = await client.aiModelProfile.updateMany({
    where: {
      modelName: normalizedName,
      sourceUrl: LOCAL_MODEL_SOURCE_URL,
      isActive: true,
    },
    data: { isActive: false },
  });
  return result.count > 0;
}
