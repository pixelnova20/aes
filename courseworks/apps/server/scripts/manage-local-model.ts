/**
 * 文件作用：实现工程运维脚本层中的 `usage`、`readArguments`、`oneOption` 等能力。
 * 模块位置：`apps/server/scripts/manage-local-model.ts`，属于工程运维脚本层。
 * 重要函数：`usage()` 负责处理占用信息；`readArguments()` 负责读取`arguments`；`oneOption()` 负责处理`one` `option`；`assertKnownOptions()` 负责断言并校验已知 `options`；`addModel()` 负责处理`add` 模型；`listModels()` 负责列出模型列表；`removeModel()` 负责移除模型。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";

import {
  deactivateLocalModelProfile,
  listLocalModelProfiles,
  prepareLocalModelProfile,
  registerLocalModelProfile,
} from "../src/modules/ai-settings/index.js";

const rootEnvPath = fileURLToPath(new URL("../../../.env", import.meta.url));
loadEnv({
  path: process.env.COURSEWORKS_ENV_FILE
    ? path.resolve(process.cwd(), process.env.COURSEWORKS_ENV_FILE)
    : rootEnvPath,
});

type ParsedArguments = {
  options: Map<string, string[]>;
  flags: Set<string>;
};

/**
 * 功能：处理占用信息。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/scripts/manage-local-model.ts 顶层流程` 调用；内部调用 `log()`。
 */
function usage() {
  console.log(`Courseworks local model catalog

Add or update a model:
  npm run model:add -- --name <model-id> --context-window <tokens> [options]

Options:
  --provider <name>          Provider label (default: Ollama)
  --alias <name>             Repeatable model alias
  --note <text>              Administrator note
  --dry-run                  Validate and print without changing the database

List registered local models:
  npm run model:list

Deactivate a registered local model:
  npm run model:remove -- --name <model-id>
`);
}

/**
 * 功能：读取`arguments`。
 * 输入：`values`（string[]）提供values。
 * 输出：返回 ParsedArguments，供调用方继续处理。
 * 调用关系：由 `apps/server/scripts/manage-local-model.ts 顶层流程` 调用；内部调用 `startsWith()`、`add()`。
 */
function readArguments(values: string[]): ParsedArguments {
  const options = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (!argument?.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    if (argument === "--dry-run" || argument === "--help") {
      flags.add(argument);
      continue;
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}.`);
    const existing = options.get(argument) ?? [];
    existing.push(value);
    options.set(argument, existing);
    index += 1;
  }
  return { options, flags };
}

/**
 * 功能：处理`one` `option`。
 * 输入：`parsed`（ParsedArguments）提供parsed。 `name`（string）提供name。 `required`提供required。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/scripts/manage-local-model.ts:addModel()`、`apps/server/scripts/manage-local-model.ts:removeModel()` 调用。
 */
function oneOption(parsed: ParsedArguments, name: string, required = false) {
  const values = parsed.options.get(name) ?? [];
  if (values.length > 1) throw new Error(`${name} may only be specified once.`);
  const value = values[0]?.trim();
  if (required && !value) throw new Error(`${name} is required.`);
  return value;
}

/**
 * 功能：断言并校验已知 `options`。
 * 输入：`parsed`（ParsedArguments）提供parsed。 `allowed`（Set<string>）提供allowed。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/scripts/manage-local-model.ts:addModel()`、`apps/server/scripts/manage-local-model.ts:listModels()`、`apps/server/scripts/manage-local-model.ts:removeModel()` 调用；内部调用 `keys()`、`has()`。
 */
function assertKnownOptions(parsed: ParsedArguments, allowed: Set<string>) {
  for (const name of parsed.options.keys()) {
    if (!allowed.has(name)) throw new Error(`Unknown option: ${name}`);
  }
}

/**
 * 功能：处理`add` 模型。
 * 输入：`parsed`（ParsedArguments）提供parsed。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/scripts/manage-local-model.ts 顶层流程` 调用；内部调用 `assertKnownOptions()`、`oneOption()`、`has()`、`log()`、`stringify()`、`prepareLocalModelProfile()`。
 */
async function addModel(parsed: ParsedArguments) {
  assertKnownOptions(parsed, new Set([
    "--name",
    "--provider",
    "--context-window",
    "--alias",
    "--note",
  ]));
  const modelName = oneOption(parsed, "--name", true)!;
  const rawContextWindow = oneOption(parsed, "--context-window", true)!;
  const contextWindowTokens = Number(rawContextWindow);
  const input = {
    modelName,
    providerName: oneOption(parsed, "--provider"),
    contextWindowTokens,
    aliases: parsed.options.get("--alias"),
    sourceNote: oneOption(parsed, "--note"),
  };
  if (parsed.flags.has("--dry-run")) {
    console.log(JSON.stringify(prepareLocalModelProfile(input), null, 2));
    return;
  }
  const profile = await registerLocalModelProfile(input);
  console.log(`Registered local model '${profile.modelName}' with ${profile.contextWindowTokens} context tokens.`);
}

/**
 * 功能：列出模型列表。
 * 输入：`parsed`（ParsedArguments）提供parsed。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/scripts/manage-local-model.ts 顶层流程` 调用；内部调用 `assertKnownOptions()`、`has()`、`listLocalModelProfiles()`、`log()`、`table()`、`isArray()`。
 */
async function listModels(parsed: ParsedArguments) {
  assertKnownOptions(parsed, new Set());
  if (parsed.flags.has("--dry-run")) throw new Error("--dry-run is only valid with model:add.");
  const profiles = await listLocalModelProfiles();
  if (profiles.length === 0) {
    console.log("No local models are registered.");
    return;
  }
  console.table(profiles.map((profile) => ({
    model: profile.modelName,
    provider: profile.providerName ?? "",
    contextWindow: profile.contextWindowTokens,
    aliases: Array.isArray(profile.aliases) ? profile.aliases.join(", ") : "",
  })));
}

/**
 * 功能：移除模型。
 * 输入：`parsed`（ParsedArguments）提供parsed。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/scripts/manage-local-model.ts 顶层流程` 调用；内部调用 `assertKnownOptions()`、`has()`、`oneOption()`、`deactivateLocalModelProfile()`、`log()`。
 */
async function removeModel(parsed: ParsedArguments) {
  assertKnownOptions(parsed, new Set(["--name"]));
  if (parsed.flags.has("--dry-run")) throw new Error("--dry-run is only valid with model:add.");
  const modelName = oneOption(parsed, "--name", true)!;
  if (!await deactivateLocalModelProfile(modelName)) {
    throw new Error(`Active local model '${modelName}' was not found.`);
  }
  console.log(`Deactivated local model '${modelName}'.`);
}

const [command, ...argumentValues] = process.argv.slice(2);
const parsed = readArguments(argumentValues);
if (!command || parsed.flags.has("--help")) {
  usage();
  process.exitCode = command ? 0 : 2;
} else {
  try {
    if (command === "add") await addModel(parsed);
    else if (command === "list") await listModels(parsed);
    else if (command === "remove") await removeModel(parsed);
    else throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
