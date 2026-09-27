/**
 * 文件作用：验证后端“AI Provider 与模型设置”业务模块中的关键行为和回归场景。
 * 模块位置：`apps/server/src/modules/ai-settings/pi-model-catalog.test.ts`，属于后端“AI Provider 与模型设置”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_MODEL_SOURCE_URL,
} from "./local-model-catalog.service.js";
import {
  resolveContextWindowTokens,
} from "./model-profile.service.js";
import { findPiModelMetadata, findPiProviderId } from "./models-dev-catalog.js";

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("loads context and output limits from Pi's hydrated models.dev catalog", () => {
  const glm = findPiModelMetadata("GLM-5.2");
  const deepSeek = findPiModelMetadata("DeepSeek-V4-Pro");

  assert.equal(glm?.contextWindowTokens, 1_000_000);
  assert.equal(glm?.maxOutputTokens, 131_072);
  assert.equal(glm?.reasoning, true);
  assert.equal(deepSeek?.contextWindowTokens, 1_000_000);
  assert.equal(deepSeek?.maxOutputTokens, 384_000);
  assert.equal(findPiModelMetadata("courseworks-unknown-model"), null);
});

test("matches model metadata by provider endpoint and exact model id", () => {
  const openAi = findPiModelMetadata("gpt-5.6-sol", "https://api.openai.com/v1");
  const openRouter = findPiModelMetadata(
    "openai/gpt-5.6-sol",
    "https://openrouter.ai/api/v1",
  );

  assert.equal(findPiProviderId("https://api.openai.com/v1/"), "openai");
  assert.equal(findPiProviderId("http://provider.example.test:6721/v1"), null);
  assert.equal(openAi?.providerId, "openai");
  assert.equal(openAi?.contextWindowTokens, 272_000);
  assert.equal(openAi?.thinkingLevelMap.minimal, null);
  assert.equal(openAi?.thinkingLevelMap.max, "max");
  assert.equal(openRouter?.providerId, "openrouter");
  assert.equal(openRouter?.contextWindowTokens, 1_050_000);
  assert.equal(openRouter?.thinkingLevelMap.minimal, "minimal");
});

test("uses only common exact-id capabilities for an unknown gateway", () => {
  const metadata = findPiModelMetadata(
    "gpt-5.6-sol",
    "http://provider.example.test:6721/v1",
  );

  assert.equal(metadata?.providerId, null);
  assert.equal(metadata?.contextWindowTokens, 272_000);
  assert.equal(metadata?.thinkingLevelMap.minimal, null);
  assert.equal(metadata?.thinkingLevelMap.low, "low");
  assert.equal(metadata?.thinkingLevelMap.max, "max");
  assert.equal(findPiModelMetadata(
    "gpt-oss:120b",
    "http://provider.example.test:6721/v1",
  ), null);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("prefers a locally registered deployment limit over models.dev", async () => {
  const contextWindowTokens = await resolveContextWindowTokens(
    "GLM-5.2",
    undefined,
    {
      aiModelProfile: {
        findMany: async () => [{
          id: "local-glm",
          providerName: "Ollama",
          modelName: "GLM-5.2",
          aliases: [],
          contextWindowTokens: 32_768,
          effectiveInputTokens: 24_576,
          sourceUrl: LOCAL_MODEL_SOURCE_URL,
          sourceNote: "Local test profile.",
          isActive: true,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        }],
      },
    } as unknown as Parameters<typeof resolveContextWindowTokens>[2],
  );

  assert.equal(contextWindowTokens, 32_768);
});

test("prefers an explicitly configured context window over catalog metadata", async () => {
  const contextWindowTokens = await resolveContextWindowTokens(
    "gpt-5.6-sol",
    272_000,
    {
      aiModelProfile: {
        findMany: async () => {
          throw new Error("Catalog should not be queried for an explicit value.");
        },
      },
    } as unknown as Parameters<typeof resolveContextWindowTokens>[2],
  );

  assert.equal(contextWindowTokens, 272_000);
});
