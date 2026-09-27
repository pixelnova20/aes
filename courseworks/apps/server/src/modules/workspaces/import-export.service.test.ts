/**
 * 文件作用：验证后端“学生工作区”业务模块中的关键行为和回归场景。
 * 模块位置：`apps/server/src/modules/workspaces/import-export.service.test.ts`，属于后端“学生工作区”业务模块。
 * 重要函数：`makeTempWorkspace()` 负责生成`temp` 工作区；`readArchive()` 负责读取`archive`；`crc32()` 负责处理`crc32`；`makeStoredZipBuffer()` 负责生成`stored` `zip` `buffer`；`makeSampleProject()` 负责生成`sample` `project`。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import { createWorkspaceExportZip, importWorkspaceArchive } from "./import-export.service.js";
import { config } from "../../config/index.js";

const execFile = promisify(execFileCallback);
const CRC32_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

/**
 * 功能：生成`temp` 工作区。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.test.ts 顶层流程` 调用；内部调用 `mkdtemp()`、`tmpdir()`、`mkdir()`。
 */
async function makeTempWorkspace() {
  const previousWorkspaceRoot = config.WORKSPACE_ROOT;
  const testWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "courseworks-workspace-import-export-root-"));
  // 归档导入导出测试需要保留 WORKSPACE_ROOT 边界检查，但临时文件不应进入真实学生 workspace。
  config.WORKSPACE_ROOT = testWorkspaceRoot;
  const root = await fs.mkdtemp(path.join(testWorkspaceRoot, "workspace-import-export-test-"));
  const workspacePath = path.join(root, "project");
  await fs.mkdir(workspacePath, { recursive: true });
  return {
    root: testWorkspaceRoot,
    workspacePath,
    restoreConfig: () => {
      config.WORKSPACE_ROOT = previousWorkspaceRoot;
    }
  };
}

/**
 * 功能：读取`archive`。
 * 输入：`filePath`（string）提供文件 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.test.ts 顶层流程` 调用；内部调用 `readFile()`。
 */
async function readArchive(filePath: string) {
  return fs.readFile(filePath);
}

/**
 * 功能：处理`crc32`。
 * 输入：`buffer`（Buffer）提供buffer。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.test.ts:makeStoredZipBuffer()` 调用。
 */
function crc32(buffer: Buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * 功能：生成`stored` `zip` `buffer`。
 * 输入：`entryName`（string | Buffer）提供entry name。 `content`（string）提供content。 `flags`提供flags。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.test.ts 顶层流程` 调用；内部调用 `from()`、`crc32()`、`alloc()`、`writeUInt32LE()`、`writeUInt16LE()`、`concat()`。
 */
function makeStoredZipBuffer(entryName: string | Buffer, content: string, flags = 0) {
  // 手工 ZIP 构造器用于覆盖系统 zip 不容易生成的边界情况，例如未声明 UTF-8 的 GBK 文件名。
  const fileName = typeof entryName === "string" ? Buffer.from(entryName, "utf8") : entryName;
  const payload = Buffer.from(content, "utf8");
  const crc = crc32(payload);

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(flags, 6);
  localHeader.writeUInt16LE(0, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(payload.length, 18);
  localHeader.writeUInt32LE(payload.length, 22);
  localHeader.writeUInt16LE(fileName.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(flags, 8);
  centralHeader.writeUInt16LE(0, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(payload.length, 20);
  centralHeader.writeUInt32LE(payload.length, 24);
  centralHeader.writeUInt16LE(fileName.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);

  const centralDirectory = Buffer.concat([centralHeader, fileName]);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(1, 8);
  endOfCentralDirectory.writeUInt16LE(1, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(localHeader.length + fileName.length + payload.length, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([localHeader, fileName, payload, centralDirectory, endOfCentralDirectory]);
}

/**
 * 功能：生成`sample` `project`。
 * 输入：`sourceRoot`（string）提供source 根目录。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/workspaces/import-export.service.test.ts 顶层流程` 调用；内部调用 `mkdir()`、`writeFile()`。
 */
async function makeSampleProject(sourceRoot: string) {
  const projectRoot = path.join(sourceRoot, "sample-project");
  await fs.mkdir(path.join(projectRoot, "kernel"), { recursive: true });
  await fs.writeFile(path.join(projectRoot, "README.md"), "# sample\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "Makefile"), "all:\n\t@echo ok\n", "utf8");
  await fs.writeFile(path.join(projectRoot, "kernel", "main.c"), "int main(void) { return 0; }\n", "utf8");
  return projectRoot;
}

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("imports a zip archive into the workspace", async () => {
  const { root, workspacePath, restoreConfig } = await makeTempWorkspace();
  try {
    const projectRoot = await makeSampleProject(root);
    const archivePath = path.join(root, "sample-project.zip");
    await execFile("zip", ["-rq", archivePath, "sample-project"], { cwd: root });

    const summary = await importWorkspaceArchive({
      workspacePath,
      originalName: "sample-project.zip",
      archiveBuffer: await readArchive(archivePath),
      mode: "extract"
    });

    assert.equal(summary.writtenCount, 3);
    assert.equal(await fs.readFile(path.join(workspacePath, "sample-project", "README.md"), "utf8"), "# sample\n");
  } finally {
    restoreConfig();
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("imports a legacy Windows zip with GBK encoded Chinese filenames", async () => {
  const { root, workspacePath, restoreConfig } = await makeTempWorkspace();
  try {
    const archivePath = path.join(root, "legacy-windows.zip");
    const gbkFileName = Buffer.concat([
      Buffer.from([0xc7, 0xb0, 0xd6, 0xc3, 0xd4, 0xbc, 0xca, 0xf8]),
      Buffer.from(".md", "ascii")
    ]);
    await fs.writeFile(archivePath, makeStoredZipBuffer(gbkFileName, "# MyVibeOS前置约束\n"));

    const summary = await importWorkspaceArchive({
      workspacePath,
      originalName: "legacy-windows.zip",
      archiveBuffer: await readArchive(archivePath),
      mode: "extract"
    });

    assert.equal(summary.writtenCount, 1);
    assert.equal(summary.writtenFiles[0], "前置约束.md");
    assert.equal(await fs.readFile(path.join(workspacePath, "前置约束.md"), "utf8"), "# MyVibeOS前置约束\n");
  } finally {
    restoreConfig();
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("imports a tar.gz archive into the workspace", async () => {
  const { root, workspacePath, restoreConfig } = await makeTempWorkspace();
  try {
    await makeSampleProject(root);
    const archivePath = path.join(root, "sample-project.tar.gz");
    await execFile("tar", ["-czf", archivePath, "sample-project"], { cwd: root });

    const summary = await importWorkspaceArchive({
      workspacePath,
      originalName: "sample-project.tar.gz",
      archiveBuffer: await readArchive(archivePath),
      mode: "extract"
    });

    assert.equal(summary.writtenCount, 3);
    assert.equal(await fs.readFile(path.join(workspacePath, "sample-project", "kernel", "main.c"), "utf8"), "int main(void) { return 0; }\n");
  } finally {
    restoreConfig();
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("imports a tar.bz2 archive into the workspace", async () => {
  const { root, workspacePath, restoreConfig } = await makeTempWorkspace();
  try {
    await makeSampleProject(root);
    const archivePath = path.join(root, "sample-project.tar.bz2");
    await execFile("tar", ["-cjf", archivePath, "sample-project"], { cwd: root });

    const summary = await importWorkspaceArchive({
      workspacePath,
      originalName: "sample-project.tar.bz2",
      archiveBuffer: await readArchive(archivePath),
      mode: "extract"
    });

    assert.equal(summary.writtenCount, 3);
    assert.equal(await fs.readFile(path.join(workspacePath, "sample-project", "Makefile"), "utf8"), "all:\n\t@echo ok\n");
  } finally {
    restoreConfig();
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("archive-only mode stores the uploaded archive without extracting it", async () => {
  const { root, workspacePath, restoreConfig } = await makeTempWorkspace();
  try {
    await makeSampleProject(root);
    const archivePath = path.join(root, "sample-project.zip");
    await execFile("zip", ["-rq", archivePath, "sample-project"], { cwd: root });

    const summary = await importWorkspaceArchive({
      workspacePath,
      originalName: "sample-project.zip",
      archiveBuffer: await readArchive(archivePath),
      mode: "archive-only"
    });

    assert.equal(summary.extracted, false);
    assert.equal(await fs.readFile(path.join(workspacePath, "sample-project.zip")).then(() => true), true);
    await assert.rejects(fs.readFile(path.join(workspacePath, "sample-project", "README.md"), "utf8"));
  } finally {
    restoreConfig();
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("rejects traversal entries in zip archives", async () => {
  const { root, workspacePath, restoreConfig } = await makeTempWorkspace();
  try {
    const archivePath = path.join(root, "evil.zip");
    await fs.writeFile(archivePath, makeStoredZipBuffer("../evil.txt", "evil\n"));

    await assert.rejects(
      importWorkspaceArchive({
        workspacePath,
        originalName: "evil.zip",
        archiveBuffer: await readArchive(archivePath),
        mode: "extract"
      }),
      /超出工作区范围|绝对路径/
    );
  } finally {
    restoreConfig();
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("rejects absolute-path entries in tar archives", async () => {
  const { root, workspacePath, restoreConfig } = await makeTempWorkspace();
  try {
    const outside = path.join(root, "absolute.txt");
    await fs.writeFile(outside, "absolute\n", "utf8");
    const archivePath = path.join(root, "absolute.tar.gz");
    await execFile("tar", ["-czPf", archivePath, outside], { cwd: root });

    await assert.rejects(
      importWorkspaceArchive({
        workspacePath,
        originalName: "absolute.tar.gz",
        archiveBuffer: await readArchive(archivePath),
        mode: "extract"
      }),
      /绝对路径/
    );
  } finally {
    restoreConfig();
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("rejects symlink entries in tar archives", async () => {
  const { root, workspacePath, restoreConfig } = await makeTempWorkspace();
  try {
    const sourceRoot = path.join(root, "symlink-project");
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(path.join(root, "outside.txt"), "outside\n", "utf8");
    await fs.symlink(path.join(root, "outside.txt"), path.join(sourceRoot, "outside-link"));
    const archivePath = path.join(root, "symlink-project.tar.gz");
    await execFile("tar", ["-czf", archivePath, "symlink-project"], { cwd: root });

    await assert.rejects(
      importWorkspaceArchive({
        workspacePath,
        originalName: "symlink-project.tar.gz",
        archiveBuffer: await readArchive(archivePath),
        mode: "extract"
      }),
      /不支持的链接条目|符号链接/
    );
  } finally {
    restoreConfig();
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("default conflict policy fails instead of silently overwriting", async () => {
  const { root, workspacePath, restoreConfig } = await makeTempWorkspace();
  try {
    await makeSampleProject(root);
    await fs.mkdir(path.join(workspacePath, "sample-project"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "sample-project", "README.md"), "existing\n", "utf8");
    const archivePath = path.join(root, "sample-project.tar.gz");
    await execFile("tar", ["-czf", archivePath, "sample-project"], { cwd: root });

    await assert.rejects(
      importWorkspaceArchive({
        workspacePath,
        originalName: "sample-project.tar.gz",
        archiveBuffer: await readArchive(archivePath),
        mode: "extract"
      }),
      /覆盖已有文件/
    );
    assert.equal(await fs.readFile(path.join(workspacePath, "sample-project", "README.md"), "utf8"), "existing\n");
  } finally {
    restoreConfig();
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("exports the workspace as a relative-path zip", async () => {
  const { root, workspacePath, restoreConfig } = await makeTempWorkspace();
  try {
    await fs.mkdir(path.join(workspacePath, "kernel"), { recursive: true });
    await fs.writeFile(path.join(workspacePath, "README.md"), "# export\n", "utf8");
    await fs.writeFile(path.join(workspacePath, "kernel", "main.c"), "int main(void) { return 0; }\n", "utf8");

    const result = await createWorkspaceExportZip(workspacePath, "workspace-12345678");
    const { stdout } = await execFile("unzip", ["-Z1", result.archivePath]);
    const entries = stdout.split(/\r?\n/).filter(Boolean);

    assert(entries.includes("README.md"));
    assert(entries.includes("kernel/main.c"));
    assert(entries.every((entry) => !path.isAbsolute(entry)));
  } finally {
    restoreConfig();
    await fs.rm(root, { recursive: true, force: true });
  }
});
