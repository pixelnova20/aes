import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeAiIdentityPrompt } from "./runtime-ai-identity.js";

test("runtime AI identity exposes the active personal profile without secrets", () => {
  const settings = {
    name: "我的模型",
    source: "personal" as const,
    model: "deepseek-v4-pro",
    reasoningEffort: "medium",
    baseUrl: "https://provider.example/v1",
    apiKey: "super-secret-key",
  };
  const prompt = buildRuntimeAiIdentityPrompt(settings);

  assert.match(prompt, /我的模型/);
  assert.match(prompt, /个人配置/);
  assert.match(prompt, /deepseek-v4-pro/);
  assert.match(prompt, /medium/);
  assert.doesNotMatch(prompt, /provider\.example/);
  assert.doesNotMatch(prompt, /super-secret-key/);
});

test("runtime AI identity identifies an enforced class profile", () => {
  const prompt = buildRuntimeAiIdentityPrompt({
    name: "课程统一模型",
    source: "class",
    model: "gpt-oss:120b",
    reasoningEffort: "high",
  });

  assert.match(prompt, /课程统一模型/);
  assert.match(prompt, /班级强制配置/);
  assert.match(prompt, /gpt-oss:120b/);
  assert.match(prompt, /high/);
});
