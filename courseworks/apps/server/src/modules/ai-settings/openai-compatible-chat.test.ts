import assert from "node:assert/strict";
import test from "node:test";

import { buildOpenAiCompatibleChatRequest } from "./openai-compatible-chat.js";

const baseInput = {
  apiKey: "test-key",
  baseUrl: "https://example.test/v1",
  model: "gpt-oss:120b",
  temperature: 0.6,
  maxTokens: 4_096,
  systemPrompt: "system",
  userPrompt: "user",
};

test("keeps the tutor output ceiling and enables streaming", () => {
  const request = buildOpenAiCompatibleChatRequest(baseInput, true);

  assert.equal(request.max_tokens, 4_096);
  assert.equal(request.stream, true);
});

test("passes a configured reasoning level to compatible reasoning models", () => {
  const request = buildOpenAiCompatibleChatRequest(
    { ...baseInput, reasoningEffort: "low" },
    true,
  );

  assert.equal(request.reasoning_effort, "low");
});

test("does not add reasoning parameters for a non-reasoning model", () => {
  const request = buildOpenAiCompatibleChatRequest(
    { ...baseInput, model: "plain-chat-model", reasoningEffort: "low" },
    true,
  );

  assert.equal(request.reasoning_effort, undefined);
});
