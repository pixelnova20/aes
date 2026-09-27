/**
 * 文件作用：汇总并导出后端配置层的公共 API。
 * 模块位置：`apps/server/src/config/index.ts`，属于后端配置层。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import { z } from "zod";

import { findSuperuserConfig, loadSuperuserConfig } from "./superuser-config.js";

const repositoryEnvPath = fileURLToPath(new URL("../../../../.env", import.meta.url));
const defaultHomeworksAccountDatabasePath = fileURLToPath(
  new URL("../../../../../accounts-data/accounts.db", import.meta.url),
);
const defaultHomeworksCourseDatabasePath = fileURLToPath(
  new URL("../../../../../accounts-data/courses.db", import.meta.url),
);
const defaultHomeworksUploadPath = fileURLToPath(
  new URL("../../../../../homeworks/uploads", import.meta.url),
);
const defaultSlideshowDatabasePath = fileURLToPath(
  new URL("../../../../../accounts-data/slideshow.db", import.meta.url),
);
const defaultArchiveRoot = path.resolve(process.cwd(), "../archive-data");
const configuredEnvPath = process.env.COURSEWORKS_ENV_FILE;
loadEnv({
  path: configuredEnvPath ? path.resolve(process.cwd(), configuredEnvPath) : repositoryEnvPath,
});

// 配置集中在这里做一次解析和校验，其他模块只消费最终 config，
// 不再直接读取 process.env，避免隐式配置分散在代码各处。
const legacyRunnerImage = process.env.DOCKER_RUNNER_IMAGE;
const workspaceAgentRunTimeoutMs = process.env.WORKSPACE_AGENT_RUN_TIMEOUT_MS;
const legacyRunnerCpus = process.env.DOCKER_RUNNER_CPUS;
const legacyRunnerMemory = process.env.DOCKER_RUNNER_MEMORY;
const legacyRunnerPids = process.env.DOCKER_RUNNER_PIDS_LIMIT;

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  HOMEWORKS_ACCOUNT_DATABASE_PATH: z.string().min(1).default(defaultHomeworksAccountDatabasePath),
  HOMEWORKS_COURSE_DATABASE_PATH: z.string().min(1).default(defaultHomeworksCourseDatabasePath),
  HOMEWORKS_UPLOAD_PATH: z.string().min(1).default(defaultHomeworksUploadPath),
  HOMEWORKS_PUBLIC_PATH: z.string().min(1).default("/homeworks"),
  SLIDESHOW_DATABASE_PATH: z.string().min(1).default(defaultSlideshowDatabasePath),
  SLIDESHOW_PUBLIC_PATH: z.string().min(1).default("/slideshow"),
  ARCHIVE_ROOT: z.string().min(1).default(defaultArchiveRoot),
  BACKEND_HOST: z.string().default("127.0.0.1"),
  BACKEND_PORT: z.coerce.number().int().positive().default(3000),
  WORKSPACE_ROOT: z.string().min(1),
  DOCKER_TOOLBOX_IMAGE: z.string().min(1).default(legacyRunnerImage ?? "courseworks-toolbox:latest"),
  DOCKER_RESTRICTED_NETWORK: z.string().min(1).default("courseworks-restricted"),
  DOCKER_RUNNER_CPUS: z.coerce.number().positive().default(Number(legacyRunnerCpus ?? "1")),
  DOCKER_RUNNER_MEMORY: z.string().min(1).default(legacyRunnerMemory ?? "768m"),
  DOCKER_RUNNER_PIDS_LIMIT: z.coerce.number().int().positive().default(Number(legacyRunnerPids ?? "256")),
  DOCKER_AGENT_CPUS: z.coerce.number().positive().default(Number(legacyRunnerCpus ?? "1")),
  DOCKER_AGENT_MEMORY: z.string().min(1).default(legacyRunnerMemory ?? "768m"),
  DOCKER_AGENT_PIDS_LIMIT: z.coerce.number().int().positive().default(128),
  DOCKER_SHELL_CPUS: z.coerce.number().positive().default(0.5),
  DOCKER_SHELL_MEMORY: z.string().min(1).default("512m"),
  DOCKER_SHELL_PIDS_LIMIT: z.coerce.number().int().positive().default(128),
  DOCKER_QEMU_CPUS: z.coerce.number().positive().default(1),
  DOCKER_QEMU_MEMORY: z.string().min(1).default("1g"),
  DOCKER_QEMU_PIDS_LIMIT: z.coerce.number().int().positive().default(192),
  DOCKER_RUNTIME_CPUS: z.coerce.number().positive().default(0.1),
  DOCKER_RUNTIME_MEMORY: z.string().min(1).default("128m"),
  DOCKER_RUNTIME_PIDS_LIMIT: z.coerce.number().int().positive().default(32),
  DOCKER_PROVIDER_CPUS: z.coerce.number().positive().default(0.25),
  DOCKER_PROVIDER_MEMORY: z.string().min(1).default("128m"),
  DOCKER_PROVIDER_PIDS_LIMIT: z.coerce.number().int().positive().default(32),
  EXECUTION_GLOBAL_CPU_BUDGET: z.coerce.number().positive().default(6),
  EXECUTION_GLOBAL_MEMORY_BUDGET: z.string().min(1).default("18g"),
  EXECUTION_MAX_QEMU: z.coerce.number().int().positive().default(2),
  EXECUTION_MAX_HEAVY_PER_WORKSPACE: z.coerce.number().int().positive().default(1),
  EXECUTION_MAX_SHELL_PER_WORKSPACE: z.coerce.number().int().positive().default(5),
  EXECUTION_ADMISSION_QUEUE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  EXECUTION_MONITOR_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  EXECUTION_CPU_HOG_THRESHOLD: z.coerce.number().min(0.1).max(1).default(0.95),
  EXECUTION_CPU_HOG_DURATION_MS: z.coerce.number().int().positive().default(30000),
  EXECUTION_MEMORY_HOG_THRESHOLD: z.coerce.number().min(0.1).max(1).default(0.9),
  EXECUTION_PID_HOG_THRESHOLD: z.coerce.number().min(0.1).max(1).default(0.9),
  EXECUTION_MEMORY_PID_DURATION_MS: z.coerce.number().int().positive().default(5000),
  EXECUTION_SHELL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30 * 60 * 1000),
  EXECUTION_SESSION_MAX_LIFETIME_MS: z.coerce.number().int().positive().default(2 * 60 * 60 * 1000),
  EXECUTION_OUTPUT_MAX_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  EXECUTION_OUTPUT_RATE_BYTES_PER_SEC: z.coerce.number().int().positive().default(2 * 1024 * 1024),
  EXECUTION_OUTPUT_RATE_DURATION_MS: z.coerce.number().int().positive().default(5000),
  EXECUTION_TOOL_TIMEOUT_DEFAULT_SECONDS: z.coerce.number().int().positive().default(30),
  EXECUTION_TOOL_TIMEOUT_HARD_MAX_SECONDS: z.coerce.number().int().positive().default(60),
  WORKSPACE_DISK_SOFT_LIMIT_BYTES: z.coerce.number().int().positive().default(225 * 1024 * 1024),
  WORKSPACE_DISK_HARD_LIMIT_BYTES: z.coerce.number().int().positive().default(250 * 1024 * 1024),
  WORKSPACE_AGENT_RUN_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(
    Number.parseInt(workspaceAgentRunTimeoutMs ?? "0", 10) || 0
  ),
  DEFAULT_AI_TEMPERATURE: z.coerce.number().default(0.7),
  WEB_SEARCH_PROVIDER: z.enum(["disabled", "brave", "bing", "duckduckgo"]).default("bing"),
  WEB_SEARCH_API_KEY: z.string().optional(),
  WEB_SEARCH_MAX_RESULTS: z.coerce.number().int().positive().max(10).default(5),
  WEB_SEARCH_TIMEOUT_MS: z.coerce.number().int().positive().max(30000).default(10000),
  QEMU_SMOKE_TIMEOUT_MS: z.coerce.number().int().positive().max(120000).default(30000),
  AGENT_LLM_TIMEOUT_MS: z.coerce.number().int().positive().max(600000).default(600000)
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration.");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const superuserConfigPath = process.env.SUPERUSER_CONFIG_PATH
  ? path.resolve(process.cwd(), process.env.SUPERUSER_CONFIG_PATH)
  : findSuperuserConfig();
const superuser = loadSuperuserConfig(superuserConfigPath);

function cappedMemory(current: string, limitMb: number) {
  const match = current.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)([kmgt]?)$/);
  if (!match) return `${limitMb}m`;
  const unit = match[2] ?? "";
  const multiplier = unit === "t" ? 1024 ** 4
    : unit === "g" ? 1024 ** 3
      : unit === "m" ? 1024 ** 2
        : unit === "k" ? 1024
          : 1;
  const currentBytes = Number(match[1]) * multiplier;
  const limitBytes = limitMb * 1024 ** 2;
  return currentBytes <= limitBytes ? current : `${limitMb}m`;
}

const executionLimits = superuser.limits.execution;
const workspaceLimits = superuser.limits.workspace;
const capped = {
  DOCKER_RUNNER_CPUS: Math.min(parsed.data.DOCKER_RUNNER_CPUS, executionLimits.maxCpuCores),
  DOCKER_RUNNER_MEMORY: cappedMemory(parsed.data.DOCKER_RUNNER_MEMORY, executionLimits.maxMemoryMb),
  DOCKER_RUNNER_PIDS_LIMIT: Math.min(parsed.data.DOCKER_RUNNER_PIDS_LIMIT, executionLimits.maxProcesses),
  DOCKER_AGENT_CPUS: Math.min(parsed.data.DOCKER_AGENT_CPUS, executionLimits.maxCpuCores),
  DOCKER_AGENT_MEMORY: cappedMemory(parsed.data.DOCKER_AGENT_MEMORY, executionLimits.maxMemoryMb),
  DOCKER_AGENT_PIDS_LIMIT: Math.min(parsed.data.DOCKER_AGENT_PIDS_LIMIT, executionLimits.maxProcesses),
  DOCKER_SHELL_CPUS: Math.min(parsed.data.DOCKER_SHELL_CPUS, executionLimits.maxCpuCores),
  DOCKER_SHELL_MEMORY: cappedMemory(parsed.data.DOCKER_SHELL_MEMORY, executionLimits.maxMemoryMb),
  DOCKER_SHELL_PIDS_LIMIT: Math.min(parsed.data.DOCKER_SHELL_PIDS_LIMIT, executionLimits.maxProcesses),
  DOCKER_QEMU_CPUS: Math.min(parsed.data.DOCKER_QEMU_CPUS, executionLimits.maxCpuCores),
  DOCKER_QEMU_MEMORY: cappedMemory(parsed.data.DOCKER_QEMU_MEMORY, executionLimits.maxMemoryMb),
  DOCKER_QEMU_PIDS_LIMIT: Math.min(parsed.data.DOCKER_QEMU_PIDS_LIMIT, executionLimits.maxProcesses),
  DOCKER_RUNTIME_CPUS: Math.min(parsed.data.DOCKER_RUNTIME_CPUS, executionLimits.maxCpuCores),
  DOCKER_RUNTIME_MEMORY: cappedMemory(parsed.data.DOCKER_RUNTIME_MEMORY, executionLimits.maxMemoryMb),
  DOCKER_RUNTIME_PIDS_LIMIT: Math.min(parsed.data.DOCKER_RUNTIME_PIDS_LIMIT, executionLimits.maxProcesses),
  DOCKER_PROVIDER_CPUS: Math.min(parsed.data.DOCKER_PROVIDER_CPUS, executionLimits.maxCpuCores),
  DOCKER_PROVIDER_MEMORY: cappedMemory(parsed.data.DOCKER_PROVIDER_MEMORY, executionLimits.maxMemoryMb),
  DOCKER_PROVIDER_PIDS_LIMIT: Math.min(parsed.data.DOCKER_PROVIDER_PIDS_LIMIT, executionLimits.maxProcesses),
};

if (
  parsed.data.NODE_ENV === "production"
  && superuser.email === "abc@abc.com"
  && superuser.password === "abcdef"
) {
  throw new Error(`生产环境不能使用 superuser.toml 中的示例凭据 (${superuserConfigPath})。`);
}

// 经过校验后的最终运行时配置。超级用户凭据只从根目录 TOML 文件读取。
export const config = {
  ...parsed.data,
  ...capped,
  EXECUTION_MAX_QEMU: executionLimits.maxConcurrentQemu,
  EXECUTION_MAX_SHELL_PER_WORKSPACE: workspaceLimits.maxTerminals,
  EXECUTION_SHELL_IDLE_TIMEOUT_MS: workspaceLimits.idleMinutes * 60 * 1000,
  WORKSPACE_DISK_SOFT_LIMIT_BYTES: Math.floor(workspaceLimits.diskMb * 1024 * 1024 * 0.9),
  WORKSPACE_DISK_HARD_LIMIT_BYTES: workspaceLimits.diskMb * 1024 * 1024,
  AI_MAX_CONCURRENT_REQUESTS_PER_USER: superuser.limits.ai.maxConcurrentRequestsPerUser,
  SUPERUSER_CONFIG_PATH: superuserConfigPath,
  SUPERUSER: superuser,
};
