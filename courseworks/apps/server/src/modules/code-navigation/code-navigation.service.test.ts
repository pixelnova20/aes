/**
 * 文件作用：验证后端“代码符号导航”业务模块中的关键行为和回归场景。
 * 模块位置：`apps/server/src/modules/code-navigation/code-navigation.service.test.ts`，属于后端“代码符号导航”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findCodeDefinitions } from "./code-navigation.service.js";

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("findCodeDefinitions returns external definitions before local definitions", async (context) => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "courseworks-code-navigation-"));
  context.after(async () => rm(workspaceRoot, { recursive: true, force: true }));

  const workspacePath = path.join(workspaceRoot, "project");
  await mkdir(workspacePath);
  await writeFile(
    path.join(workspaceRoot, ".tags"),
    [
      `target\t${path.join(workspacePath, "main.c")}\t10;\"\tkind:function\tline:10`,
      `target\t${path.join(workspacePath, "src", "target.c")}\t4;\"\tkind:function\tline:4`,
      `other\t${path.join(workspacePath, "other.c")}\t2;\"\tkind:function\tline:2`,
    ].join("\n"),
  );

  const definitions = await findCodeDefinitions(workspacePath, "main.c", "target");

  assert.deepEqual(definitions, [
    { name: "target", file: "src/target.c", line: 4, kind: "function" },
    { name: "target", file: "main.c", line: 10, kind: "function" },
  ]);
});
