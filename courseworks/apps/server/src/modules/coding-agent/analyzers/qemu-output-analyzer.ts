/**
 * 文件作用：实现后端“Coding Agent 与 Pi 适配”业务模块中的 `analyzeQemuOutput` 等能力。
 * 模块位置：`apps/server/src/modules/coding-agent/analyzers/qemu-output-analyzer.ts`，属于后端“Coding Agent 与 Pi 适配”业务模块。
 * 重要函数：`analyzeQemuOutput()` 负责分析QEMU 输出。
 */
import OpenAI from "openai";
import type { AiSettings } from "../../ai-settings/index.js";

/** 分析真实 qemu-smoke 输出，并向学生返回 Markdown 说明。 */
/**
 * 功能：分析QEMU 输出。
 * 输入：`settings`（AiSettings）提供设置。 `output`（string）提供输出。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/agent/agent-application.service.ts:analyzeAgentQemuRun()` 调用；内部调用 `create()`。
 */
export async function analyzeQemuOutput(settings: AiSettings, output: string) {
  const client = new OpenAI({ apiKey: settings.apiKey, baseURL: settings.baseUrl, timeout: 30000 });
  const completion = await client.chat.completions.create({
    model: settings.model,
    temperature: 0.2,
    max_tokens: 1800,
    messages: [
      { role: "system", content: "Analyze only the provided QEMU serial smoke output. Return Markdown. Do not invent successful boot behavior." },
      { role: "user", content: output.slice(-12000) }
    ]
  });
  return completion.choices[0]?.message?.content?.trim() || "## QEMU Output Analysis\n\nNo analysis returned.";
}
