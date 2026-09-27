import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findSuperuserConfig, loadSuperuserConfig } from "./superuser-config.js";

function withConfig(contents: string, callback: (configPath: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aes-superuser-"));
  const configPath = path.join(directory, "superuser.toml");
  fs.writeFileSync(configPath, contents, "utf8");
  try {
    callback(configPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const limits = `
[limits.workspace]
disk_mb = 250
max_terminals = 5
idle_minutes = 30

[limits.execution]
max_cpu_cores = 1.0
max_memory_mb = 1024
max_processes = 192
max_concurrent_qemu = 2

[limits.ai]
max_concurrent_requests_per_user = 1
`;

test("loads and normalizes a valid superuser configuration", () => {
  withConfig(`[superuser]\nemail = "Admin@Example.com"\npassword = "secret"\n${limits}`, (configPath) => {
    assert.deepEqual(loadSuperuserConfig(configPath), {
      email: "admin@example.com",
      password: "secret",
      limits: {
        workspace: { diskMb: 250, maxTerminals: 5, idleMinutes: 30 },
        execution: {
          maxCpuCores: 1,
          maxMemoryMb: 1024,
          maxProcesses: 192,
          maxConcurrentQemu: 2,
        },
        ai: { maxConcurrentRequestsPerUser: 1 },
      },
    });
  });
});

test("rejects missing or malformed credentials", () => {
  withConfig(`[superuser]\nemail = "not-an-email"\npassword = "short"\n${limits}`, (configPath) => {
    assert.throws(() => loadSuperuserConfig(configPath), /超级用户配置无效/);
  });
});

test("rejects unsafe or incomplete resource limits", () => {
  withConfig(`[superuser]\nemail = "admin@example.com"\npassword = "secret12"\n${limits.replace("max_processes = 192", "max_processes = 2")}`, (configPath) => {
    assert.throws(() => loadSuperuserConfig(configPath), /超级用户配置无效/);
  });
});

test("supports the legacy root credential format with safe resource defaults", () => {
  withConfig('superuser = "admin@example.com"\npassword = "secret12"\n', (configPath) => {
    assert.deepEqual(loadSuperuserConfig(configPath).limits, {
      workspace: { diskMb: 250, maxTerminals: 5, idleMinutes: 30 },
      execution: {
        maxCpuCores: 1,
        maxMemoryMb: 1024,
        maxProcesses: 192,
        maxConcurrentQemu: 2,
      },
      ai: { maxConcurrentRequestsPerUser: 1 },
    });
  });
});

test("finds the nearest superuser configuration above the working directory", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aes-superuser-find-"));
  const nested = path.join(directory, "courseworks", "apps", "server");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(directory, "superuser.toml"), "", "utf8");
  try {
    assert.equal(findSuperuserConfig(nested), path.join(directory, "superuser.toml"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
