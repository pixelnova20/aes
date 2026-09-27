/**
 * 文件作用：验证后端“AI Provider 与模型设置”业务模块中的关键行为和回归场景。
 * 模块位置：`apps/server/src/modules/ai-settings/model-capability.service.test.ts`，属于后端“AI Provider 与模型设置”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProviderTestRequest,
  normalizeReasoningEffortForModel,
  normalizeProviderBaseUrl,
  resolveModelCapabilities,
} from "./model-capability.service.js";

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("resolves GLM capabilities for a generic OpenAI-compatible gateway", () => {
  const capabilities = resolveModelCapabilities({ model: "GLM-5.2" });

  assert.equal(capabilities.family, "zai");
  assert.equal(capabilities.reasoning, true);
  assert.equal(capabilities.thinkingLevel, "high");
  assert.equal(capabilities.contextWindowTokens, 1_000_000);
  assert.equal(capabilities.effectiveInputTokens, 1_000_000);
  assert.equal(capabilities.maxTokens, 32_768);
  assert.equal(capabilities.compat.thinkingFormat, "zai");
  assert.equal(capabilities.compat.maxTokensField, "max_completion_tokens");
  assert.ok(capabilities.compactionTriggerTokens < capabilities.effectiveInputTokens);

  assert.deepEqual(buildProviderTestRequest("GLM-5.2"), {
    model: "GLM-5.2",
    messages: [{ role: "user", content: "Reply with OK only." }],
    temperature: 0,
    max_completion_tokens: 64,
    thinking: { type: "disabled" },
  });
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("resolves DeepSeek and generic model compatibility independently", () => {
  const deepSeek = resolveModelCapabilities({ model: "DeepSeek-V4-Pro" });
  const generic = resolveModelCapabilities({
    model: "custom-chat-model",
    contextWindowTokens: 32_000,
  });

  assert.equal(deepSeek.family, "deepseek");
  assert.equal(deepSeek.reasoning, true);
  assert.equal(deepSeek.compat.thinkingFormat, "deepseek");
  assert.equal(generic.family, "generic");
  assert.equal(generic.reasoning, false);
  assert.equal(generic.contextWindowTokens, 32_000);
  assert.equal(generic.maxTokens, 8_000);
  assert.equal(generic.compat.maxTokensField, "max_tokens");
});

test("derives reasoning effort from provider-specific model metadata", () => {
  const gpt = resolveModelCapabilities({
    model: "gpt-5.6-sol",
    baseUrl: "https://api.openai.com/v1",
    reasoningEffort: "high",
  });
  const local = resolveModelCapabilities({
    model: "local-chat:8b",
    reasoningEffort: "high",
  });

  assert.deepEqual(gpt.reasoningEffortOptions, [
    "default",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(gpt.thinkingLevel, "high");
  assert.deepEqual(buildProviderTestRequest(
    "gpt-5.6-sol",
    "max",
    "https://api.openai.com/v1",
  ), {
    model: "gpt-5.6-sol",
    messages: [{ role: "user", content: "Reply with OK only." }],
    temperature: 0,
    max_completion_tokens: 64,
    reasoning_effort: "max",
  });
  assert.deepEqual(local.reasoningEffortOptions, ["default"]);
  assert.equal(local.thinkingLevel, "off");
  assert.equal(normalizeReasoningEffortForModel("local-chat:8b", "high"), "default");
  assert.deepEqual(
    resolveModelCapabilities({ model: "gpt-oss:120b" }).reasoningEffortOptions,
    ["default"],
  );
  assert.equal(normalizeReasoningEffortForModel(
    "gpt-5.6-sol",
    "max",
    "https://api.openai.com/v1",
  ), "max");
  assert.equal(normalizeReasoningEffortForModel("gpt-oss:120b", "max"), "default");
});

/**
 * 功能：验证模型图片输入能力按模型类型保守解析。
 * 输入：GPT 视觉模型、gpt-oss 文本模型、Qwen 视觉模型和普通本地模型。
 * 输出：只有已识别的视觉模型允许直接发送图片。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用；内部调用 `resolveModelCapabilities()`。
 */
test("resolves direct image input capability by model family", () => {
  assert.equal(resolveModelCapabilities({ model: "gpt-5.6-sol" }).supportsImages, true);
  assert.equal(resolveModelCapabilities({ model: "gpt-oss:120b" }).supportsImages, false);
  assert.equal(resolveModelCapabilities({ model: "qwen2.5-vl-72b" }).supportsImages, true);
  assert.equal(resolveModelCapabilities({ model: "local-chat:8b" }).supportsImages, false);
});

test("uses the matched provider's model-specific effort map", () => {
  const openAi = resolveModelCapabilities({
    model: "gpt-5.2-chat-latest",
    baseUrl: "https://api.openai.com/v1",
  });
  const openRouter = resolveModelCapabilities({
    model: "openai/gpt-5.6-sol",
    baseUrl: "https://openrouter.ai/api/v1",
  });

  assert.deepEqual(openAi.reasoningEffortOptions, ["default", "medium", "xhigh"]);
  assert.deepEqual(openRouter.reasoningEffortOptions, [
    "default",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(openRouter.compat.thinkingFormat, "openrouter");
  assert.deepEqual(buildProviderTestRequest(
    "openai/gpt-5.6-sol",
    "max",
    "https://openrouter.ai/api/v1",
  ), {
    model: "openai/gpt-5.6-sol",
    messages: [{ role: "user", content: "Reply with OK only." }],
    temperature: 0,
    max_tokens: 64,
    reasoning: { effort: "max" },
  });
});

test("uses provider transport compatibility with the matched thinking map", () => {
  const zai = resolveModelCapabilities({
    model: "glm-5.2",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
  });

  assert.deepEqual(zai.reasoningEffortOptions, [
    "default",
    "low",
    "medium",
    "high",
    "max",
  ]);
  assert.equal(zai.compat.thinkingFormat, "zai");
  assert.equal(zai.compat.supportsReasoningEffort, true);
  assert.deepEqual(buildProviderTestRequest(
    "glm-5.2",
    "max",
    "https://api.z.ai/api/coding/paas/v4",
  ), {
    model: "glm-5.2",
    messages: [{ role: "user", content: "Reply with OK only." }],
    temperature: 0,
    max_completion_tokens: 64,
    reasoning_effort: "max",
    thinking: { type: "enabled" },
  });
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("uses registered context limits for models outside the built-in catalog", () => {
  const local = resolveModelCapabilities({
    model: "qwen3.5:27b-local",
    contextWindowTokens: 262_144,
  });

  assert.equal(local.contextWindowTokens, 262_144);
  assert.equal(local.effectiveInputTokens, 262_144);
  assert.equal(local.maxTokens, 32_768);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("honors a deployment-specific context limit for a catalog model", () => {
  const localDeployment = resolveModelCapabilities({
    model: "Qwen3.5-27B",
    contextWindowTokens: 32_768,
  });

  assert.equal(localDeployment.contextWindowTokens, 32_768);
  assert.equal(localDeployment.maxTokens, 8_192);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("normalizes provider URLs and accepts a hostname without a scheme", () => {
  assert.equal(
    normalizeProviderBaseUrl("llmapi.paratera.com"),
    "https://llmapi.paratera.com/v1",
  );
  assert.equal(
    normalizeProviderBaseUrl("https://llmapi.paratera.com/v1/"),
    "https://llmapi.paratera.com/v1",
  );
  assert.throws(() => normalizeProviderBaseUrl("file:///tmp/provider"), /HTTP 或 HTTPS/);
});
