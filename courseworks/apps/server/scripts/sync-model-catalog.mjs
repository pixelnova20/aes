/**
 * 文件作用：提供工程运维脚本层所需的声明和装配。
 * 模块位置：`apps/server/scripts/sync-model-catalog.mjs`，属于工程运维脚本层。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  builtinProviders,
  getBuiltinModelDataGeneratedAt,
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";

const outputPath = fileURLToPath(
  new URL("../src/modules/ai-settings/data/models.dev.json", import.meta.url),
);
const models = getBuiltinProviders()
  .flatMap((provider) => getBuiltinModels(provider))
  .map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    api: model.api,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    ...(model.compat ? { compat: model.compat } : {}),
  }))
  .sort((left, right) =>
    left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
  );
const generatedAt = getBuiltinModelDataGeneratedAt();
const providers = builtinProviders()
  .map((provider) => ({
    id: provider.id,
    name: provider.name,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
  }))
  .sort((left, right) => left.id.localeCompare(right.id));
const catalog = {
  source: "@earendil-works/pi-ai hydrated models.dev catalog",
  generatedAt: generatedAt ? new Date(generatedAt).toISOString() : null,
  providers,
  models,
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
console.log(`Wrote ${models.length} models to ${outputPath}`);
