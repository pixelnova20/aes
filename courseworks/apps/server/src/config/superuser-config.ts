import fs from "node:fs";
import path from "node:path";

import { parse } from "smol-toml";
import { z } from "zod";

const defaultLimits = {
  workspace: { disk_mb: 250, max_terminals: 5, idle_minutes: 30 },
  execution: {
    max_cpu_cores: 1,
    max_memory_mb: 1024,
    max_processes: 192,
    max_concurrent_qemu: 2,
  },
  ai: { max_concurrent_requests_per_user: 1 },
};

const limitsSchema = z.object({
  workspace: z.object({
    disk_mb: z.number().int().min(100).max(102_400),
    max_terminals: z.number().int().min(1).max(20),
    idle_minutes: z.number().int().min(5).max(1_440),
  }).strict(),
  execution: z.object({
    max_cpu_cores: z.number().positive().max(64),
    max_memory_mb: z.number().int().min(128).max(262_144),
    max_processes: z.number().int().min(32).max(4_096),
    max_concurrent_qemu: z.number().int().min(1).max(1_024),
  }).strict(),
  ai: z.object({
    max_concurrent_requests_per_user: z.number().int().min(1).max(20),
  }).strict(),
}).strict();

const currentConfigSchema = z.object({
  superuser: z.object({
    email: z.string().trim().email(),
    password: z.string().min(6),
  }).strict(),
  limits: limitsSchema.default(defaultLimits),
}).strict();

const legacyConfigSchema = z.object({
  superuser: z.string().trim().email(),
  password: z.string().min(6),
  limits: limitsSchema.default(defaultLimits),
}).strict();

const superuserConfigSchema = z.union([currentConfigSchema, legacyConfigSchema]).transform((data) => ({
  credentials: "password" in data
    ? { email: data.superuser, password: data.password }
    : data.superuser,
  limits: data.limits,
}));

export type SuperuserConfig = {
  email: string;
  password: string;
  limits: {
    workspace: {
      diskMb: number;
      maxTerminals: number;
      idleMinutes: number;
    };
    execution: {
      maxCpuCores: number;
      maxMemoryMb: number;
      maxProcesses: number;
      maxConcurrentQemu: number;
    };
    ai: {
      maxConcurrentRequestsPerUser: number;
    };
  };
};

export function findSuperuserConfig(startDirectory = process.cwd()) {
  let directory = path.resolve(startDirectory);
  while (true) {
    const candidate = path.join(directory, "superuser.toml");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`从 ${startDirectory} 向上未找到 superuser.toml。`);
    }
    directory = parent;
  }
}

export function loadSuperuserConfig(configPath: string): SuperuserConfig {
  let source: string;
  try {
    source = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取超级用户配置 ${configPath}: ${message}`);
  }

  let document: unknown;
  try {
    document = parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`超级用户配置不是有效的 TOML (${configPath}): ${message}`);
  }

  const parsed = superuserConfigSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(
      `超级用户配置无效 (${configPath}): ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }

  return {
    email: parsed.data.credentials.email.toLowerCase(),
    password: parsed.data.credentials.password,
    limits: {
      workspace: {
        diskMb: parsed.data.limits.workspace.disk_mb,
        maxTerminals: parsed.data.limits.workspace.max_terminals,
        idleMinutes: parsed.data.limits.workspace.idle_minutes,
      },
      execution: {
        maxCpuCores: parsed.data.limits.execution.max_cpu_cores,
        maxMemoryMb: parsed.data.limits.execution.max_memory_mb,
        maxProcesses: parsed.data.limits.execution.max_processes,
        maxConcurrentQemu: parsed.data.limits.execution.max_concurrent_qemu,
      },
      ai: {
        maxConcurrentRequestsPerUser: parsed.data.limits.ai.max_concurrent_requests_per_user,
      },
    },
  };
}
