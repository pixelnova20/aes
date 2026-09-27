/**
 * 文件作用：验证后端“Agent 用例”应用编排层中的关键行为和回归场景。
 * 模块位置：`apps/server/src/application/agent/commands/inbound.test.ts`，属于后端“Agent 用例”应用编排层。
 * 重要函数：`setupWorkspace()` 负责处理`setup` 工作区；`cleanupWorkspace()` 负责处理`cleanup` 工作区。
 */
// 自动化测试：auto-reply 模块的输入解析、附件上下文、打开文件引用
// 使用 Node.js 内置 test runner。运行方式：npx tsx src/agents/auto-reply/inbound.test.ts

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ---- 被测试模块 ----
import { resolveTextCommand, isCommandMessage } from "./commands-registry.js";
import { buildInboundContext, buildUploadMediaNote, buildOpenFilesContext } from "../../../modules/coding-agent/index.js";

// ---- 测试工具 ----
const TEST_WORKSPACE = path.join(os.tmpdir(), "courseworks-test-auto-reply");

/**
 * 功能：处理`setup` 工作区。
 * 输入：无显式输入参数。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `mkdir()`、`writeFile()`。
 */
async function setupWorkspace() {
  await fs.mkdir(TEST_WORKSPACE, { recursive: true });
  await fs.writeFile(path.join(TEST_WORKSPACE, "main.c"), 'int main() { return 0; }\n', "utf8");
  await fs.writeFile(path.join(TEST_WORKSPACE, "readme.md"), '# Test Project\n\nHello world.\n', "utf8");
  await fs.writeFile(path.join(TEST_WORKSPACE, "config.json"), '{"version": "1.0"}\n', "utf8");
}

/**
 * 功能：处理`cleanup` 工作区。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `rm()`。
 */
async function cleanupWorkspace() {
  await fs.rm(TEST_WORKSPACE, { recursive: true, force: true });
}

// ======================================================================
// 第 1 类：典型用户输入解析测试
// ======================================================================
/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
describe("输入解析 — resolveTextCommand / isCommandMessage", () => {
  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("普通文本 '你好' 不是命令", () => {
    assert.equal(isCommandMessage("你好"), false);
    assert.equal(resolveTextCommand("你好"), null);
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("普通文本 '创建文件abc' 不是命令", () => {
    assert.equal(isCommandMessage("创建文件abc"), false);
    assert.equal(resolveTextCommand("创建文件abc"), null);
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("英文普通文本 'Help me write a kernel' 不是命令", () => {
    assert.equal(isCommandMessage("Help me write a kernel"), false);
    assert.equal(resolveTextCommand("Help me write a kernel"), null);
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("混合中英文 '帮我创建一个main.c文件' 不是命令", () => {
    assert.equal(isCommandMessage("帮我创建一个main.c文件"), false);
    assert.equal(resolveTextCommand("帮我创建一个main.c文件"), null);
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("空字符串不是命令", () => {
    assert.equal(isCommandMessage(""), false);
    assert.equal(isCommandMessage("   "), false);
    assert.equal(resolveTextCommand(""), null);
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("以 / 开头的随机文本不是命令", () => {
    assert.equal(isCommandMessage("/random_unknown_command"), false);
    assert.equal(resolveTextCommand("/random_unknown_command"), null);
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("只有一个 / 不是命令", () => {
    assert.equal(isCommandMessage("/"), false);
    assert.equal(resolveTextCommand("/"), null);
  });

  // ---- 斜杠命令识别 ----
  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("/new 被正确识别为命令", () => {
    assert.equal(isCommandMessage("/new"), true);
    const result = resolveTextCommand("/new");
    assert.ok(result !== null);
    assert.equal(result!.command.key, "new");
    assert.equal(result!.command.textAliases[0], "/new");
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("/NEW 大写也被识别", () => {
    assert.equal(isCommandMessage("/NEW"), true);
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("/tools 被正确识别为命令", () => {
    assert.equal(isCommandMessage("/tools"), true);
    const result = resolveTextCommand("/tools");
    assert.ok(result !== null);
    assert.equal(result!.command.key, "tools");
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("/compact 被正确识别为命令", () => {
    assert.equal(isCommandMessage("/compact"), true);
    const result = resolveTextCommand("/compact");
    assert.ok(result !== null);
    assert.equal(result!.command.key, "compact");
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("/context 被正确识别为命令", () => {
    assert.equal(isCommandMessage("/context"), true);
    const result = resolveTextCommand("/context");
    assert.ok(result !== null);
    assert.equal(result!.command.key, "context");
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("命令大小写不敏感：/ToOlS 被识别为 /tools", () => {
    assert.equal(isCommandMessage("/ToOlS"), true);
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("带空格的命令后面部分不影响识别：/new 确认", () => {
    // /new 不接受参数，所以 "/new 确认" 不是精确命令
    // 但用户可能这样输入，目前 acceptsArgs=false 所以不作为命令识别
    const result = resolveTextCommand("/new 确认");
    assert.equal(result, null);
  });
});

// ======================================================================
// 第 2 类：聊天附件 media note 测试（对齐 OpenClaw）
// ======================================================================
/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
describe("附件 media note — buildUploadMediaNote", () => {
  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("空列表返回空字符串", () => {
    assert.equal(buildUploadMediaNote([]), "");
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("单个附件生成 [media attached: path] 标注", () => {
    const result = buildUploadMediaNote([{ name: "hello.txt", workspacePath: "hello.txt" }]);
    assert.equal(result, "[media attached: hello.txt]");
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("多个附件生成编号标注", () => {
    const media = [
      { name: "a.c", workspacePath: "a.c" },
      { name: "b.h", workspacePath: "b.h" },
    ];
    const result = buildUploadMediaNote(media);
    assert.ok(result.startsWith("[media attached: 2 files]"));
    assert.ok(result.includes("1/2: a.c"));
    assert.ok(result.includes("2/2: b.h"));
  });
});

// ======================================================================
// 第 3 类：工作区打开文件测试
// ======================================================================
/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
describe("打开文件上下文 — buildOpenFilesContext", () => {
  before(setupWorkspace);
  after(cleanupWorkspace);

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("空文件列表返回空字符串", async () => {
    const result = await buildOpenFilesContext(TEST_WORKSPACE, []);
    assert.equal(result, "");
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("单个打开文件只标注路径", () => {
    const result = buildOpenFilesContext(TEST_WORKSPACE, ["main.c"]);
    assert.equal(result, "[open file: main.c]");
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("多个文件也只标注第一个", () => {
    const result = buildOpenFilesContext(TEST_WORKSPACE, ["main.c", "readme.md", "config.json"]);
    assert.equal(result, "[open file: main.c]");
  });
});

// ======================================================================
// 综合测试：buildInboundContext
// ======================================================================
/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
describe("综合入站上下文 — buildInboundContext", () => {
  before(setupWorkspace);
  after(cleanupWorkspace);

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("同时包含 media note 和打开文件", () => {
    const result = buildInboundContext({
      workspacePath: TEST_WORKSPACE,
      media: [{ name: "submit.c", workspacePath: "submit.c" }],
      openFiles: ["main.c"],
    });
    assert.ok(result.mediaNote.includes("[media attached: submit.c]"));
    assert.ok(result.openFilesContext.includes("[open file: main.c]"));
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("仅 media note，无打开文件", () => {
    const result = buildInboundContext({
      workspacePath: TEST_WORKSPACE,
      media: [{ name: "a.txt", workspacePath: "a.txt" }],
    });
    assert.ok(result.mediaNote.includes("[media attached: a.txt]"));
    assert.equal(result.openFilesContext, "");
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("仅打开文件，无 media", () => {
    const result = buildInboundContext({
      workspacePath: TEST_WORKSPACE,
      openFiles: ["readme.md"],
    });
    assert.equal(result.mediaNote, "");
    assert.equal(result.openFilesContext, "[open file: readme.md]");
  });

  /**
   * 功能：验证当前 test/describe 声明对应的行为场景。
   * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
   * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
   * 调用关系：由 Node test runner 在执行当前测试文件时调用。
   */
  it("两者都没有时返回空", () => {
    const result = buildInboundContext({ workspacePath: TEST_WORKSPACE });
    assert.equal(result.mediaNote, "");
    assert.equal(result.openFilesContext, "");
  });
});
