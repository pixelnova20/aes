/**
 * 文件作用：实现后端“AI Provider 与模型设置”业务模块中的 `runOpenAiCompatibleChat` 等能力。
 * 模块位置：`apps/server/src/modules/ai-settings/openai-compatible-chat.ts`，属于后端“AI Provider 与模型设置”业务模块。
 * 重要函数：`runOpenAiCompatibleChat()` 负责执行`open` `ai` `compatible` 聊天。
 */
import OpenAI from "openai";

import {
  resolveModelCapabilities,
  type ReasoningEffort,
} from "./model-capability.service.js";
import { estimateAiTokens, type AiTokenUsage } from "./class-ai-token-quota.service.js";

export type OpenAiCompatibleChatInput = {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  reasoningEffort?: ReasoningEffort;
  operation?: string;
  systemPrompt: string;
  userPrompt: string;
  onUsage?: (usage: AiTokenUsage) => Promise<void>;
};

function fallbackUsage(input: OpenAiCompatibleChatInput, output: string): AiTokenUsage {
  const inputTokens = estimateAiTokens(`${input.systemPrompt}\n${input.userPrompt}`);
  const outputTokens = estimateAiTokens(output);
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function providerUsage(
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null | undefined,
  fallback: AiTokenUsage,
): AiTokenUsage {
  if (!usage) return fallback;
  const inputTokens = usage.prompt_tokens ?? fallback.inputTokens;
  const outputTokens = usage.completion_tokens ?? fallback.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
  };
}

function createClient(input: OpenAiCompatibleChatInput) {
  return new OpenAI({
    apiKey: input.apiKey,
    baseURL: input.baseUrl,
    timeout: 45_000,
  });
}

function messages(input: OpenAiCompatibleChatInput) {
  return [
    { role: "system" as const, content: input.systemPrompt },
    { role: "user" as const, content: input.userPrompt },
  ];
}

export function buildOpenAiCompatibleChatRequest(
  input: OpenAiCompatibleChatInput,
  stream: boolean,
) {
  const request: Record<string, unknown> = {
    model: input.model,
    temperature: input.temperature,
    max_tokens: input.maxTokens,
    messages: messages(input),
  };
  if (stream) request.stream = true;

  const effort = input.reasoningEffort ?? "default";
  if (effort !== "default") {
    const capabilities = resolveModelCapabilities({
      model: input.model,
      baseUrl: input.baseUrl,
      reasoningEffort: effort,
    });
    if (capabilities.reasoning && capabilities.compat.supportsReasoningEffort !== false) {
      const mappedEffort = capabilities.thinkingLevelMap[effort];
      const providerEffort = typeof mappedEffort === "string" ? mappedEffort : effort;
      if (capabilities.compat.thinkingFormat === "openrouter") {
        request.reasoning = { effort: providerEffort };
      } else {
        request.reasoning_effort = providerEffort;
      }
    }
  }

  return request;
}

/**
 * 功能：执行`open` `ai` `compatible` 聊天。
 * 输入：`input`（{ apiKey: string; baseUrl: string; model: string; temperature: number; maxTokens: number; systemPrompt: string; userProm）提供当前操作所需的结构化输入。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/ai-settings/ai-settings-application.service.ts:runDirectAiChat()` 调用；内部调用 `create()`。
 */
export async function runOpenAiCompatibleChat(input: OpenAiCompatibleChatInput) {
  const client = createClient(input);
  const completion = await client.chat.completions.create(
    buildOpenAiCompatibleChatRequest(input, false) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  );
  const content = completion.choices[0]?.message?.content ?? "No response.";
  const usage = providerUsage(completion.usage, fallbackUsage(input, content));
  await input.onUsage?.(usage);
  return content;
}

export async function streamOpenAiCompatibleChat(input: OpenAiCompatibleChatInput) {
  const client = createClient(input);
  const startedAt = performance.now();
  const stream = await client.chat.completions.create(
    buildOpenAiCompatibleChatRequest(input, true) as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
  );
  const connectedMs = Math.round(performance.now() - startedAt);

  return (async function* () {
    let firstContentMs: number | null = null;
    let outputCharacters = 0;
    let output = "";
    let reportedUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null;
    let completed = false;
    try {
      for await (const chunk of stream) {
        if (chunk.usage) reportedUsage = chunk.usage;
        const content = chunk.choices[0]?.delta?.content;
        if (!content) continue;
        if (firstContentMs === null) firstContentMs = Math.round(performance.now() - startedAt);
        outputCharacters += content.length;
        output += content;
        yield content;
      }
      completed = true;
    } finally {
      await input.onUsage?.(providerUsage(reportedUsage, fallbackUsage(input, output)));
      console.info("[ai-stream]", JSON.stringify({
        operation: input.operation ?? "chat",
        model: input.model,
        level: input.reasoningEffort ?? "default",
        inputCharacters: input.systemPrompt.length + input.userPrompt.length,
        outputCharacters,
        connectedMs,
        firstContentMs,
        totalMs: Math.round(performance.now() - startedAt),
        completed,
      }));
    }
  })();
}
