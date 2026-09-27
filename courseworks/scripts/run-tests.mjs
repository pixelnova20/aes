/**
 * 文件作用：提供工程运维脚本层所需的声明和装配。
 * 模块位置：`scripts/run-tests.mjs`，属于工程运维脚本层。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "courseworks-tests-"));

try {
  const managementResult = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["test"],
    {
      cwd: path.resolve(import.meta.dirname, "../../management"),
      env: { ...process.env, NODE_ENV: "test" },
      stdio: "inherit",
    },
  );
  if (managementResult.status !== 0) {
    process.exitCode = managementResult.status ?? 1;
  }

  for (const workspace of ["@courseworks/server", "@courseworks/web"]) {
    if (process.exitCode) break;
    const result = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "test:unit", "--workspace", workspace],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: {
          ...process.env,
          NODE_ENV: "test",
          DATABASE_URL: "mysql://courseworks_test:courseworks_test@127.0.0.1:3306/courseworks_test",
          JWT_SECRET: "courseworks-test-secret-only",
          WORKSPACE_ROOT: workspaceRoot,
        },
        stdio: "inherit",
      },
    );
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
  if (!process.exitCode) {
    const result = spawnSync("bash", ["tests/restricted-network-rules-test.sh"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: "inherit",
    });
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  }
  if (!process.exitCode) {
    const result = spawnSync("bash", ["tests/nginx-port-isolation-test.sh"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      stdio: "inherit",
    });
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  }
} finally {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
}
