/**
 * 文件作用：定义后端“AI Provider 与模型设置”业务模块使用的数据结构与类型契约。
 * 模块位置：`apps/server/src/modules/ai-settings/ai-settings.types.ts`，属于后端“AI Provider 与模型设置”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import type { ReasoningEffort } from "./model-capability.service.js";

export type AiSettings = {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
};
