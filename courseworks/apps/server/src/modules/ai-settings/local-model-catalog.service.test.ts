/**
 * 文件作用：验证后端“AI Provider 与模型设置”业务模块中的关键行为和回归场景。
 * 模块位置：`apps/server/src/modules/ai-settings/local-model-catalog.service.test.ts`，属于后端“AI Provider 与模型设置”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_MODEL_SOURCE_URL,
  deactivateLocalModelProfile,
  prepareLocalModelProfile,
  registerLocalModelProfile,
} from "./local-model-catalog.service.js";

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("normalizes and stores a local model profile", async () => {
  let stored: unknown;
  const client = {
    aiModelProfile: {
      upsert: async (input: unknown) => {
        stored = input;
        return input;
      },
    },
  } as unknown as Parameters<typeof registerLocalModelProfile>[1];

  const profile = await registerLocalModelProfile({
    modelName: " qwen3.5:27b ",
    providerName: " Ollama ",
    contextWindowTokens: 32_768,
    aliases: ["qwen-local", "qwen-local", "qwen3.5:27b"],
  }, client);

  assert.equal(profile.modelName, "qwen3.5:27b");
  assert.equal(profile.sourceUrl, LOCAL_MODEL_SOURCE_URL);
  assert.deepEqual(profile.aliases, ["qwen-local"]);
  assert.deepEqual(stored, {
    where: { modelName: "qwen3.5:27b" },
    create: profile,
    update: profile,
  });
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("rejects invalid context limits before persistence", async () => {
  const client = {
    aiModelProfile: {
      upsert: async () => assert.fail("upsert must not be called"),
    },
  } as unknown as Parameters<typeof registerLocalModelProfile>[1];

  await assert.rejects(
    registerLocalModelProfile({ modelName: "local-model", contextWindowTokens: 2_048 }, client),
    /between 4096 and 2000000/,
  );
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("validates dry-run profiles without persistence", () => {
  assert.throws(
    () => prepareLocalModelProfile({ modelName: "local-model", contextWindowTokens: 2_048 }),
    /between 4096 and 2000000/,
  );
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("only deactivates active locally registered profiles", async () => {
  let received: unknown;
  const client = {
    aiModelProfile: {
      updateMany: async (input: unknown) => {
        received = input;
        return { count: 1 };
      },
    },
  } as unknown as Parameters<typeof deactivateLocalModelProfile>[1];

  assert.equal(await deactivateLocalModelProfile(" local-model ", client), true);
  assert.deepEqual(received, {
    where: {
      modelName: "local-model",
      sourceUrl: LOCAL_MODEL_SOURCE_URL,
      isActive: true,
    },
    data: { isActive: false },
  });
});
