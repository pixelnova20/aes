/**
 * 文件作用：验证后端“学生工作区”业务模块中的关键行为和回归场景。
 * 模块位置：`apps/server/src/modules/workspaces/scaffold.service.test.ts`，属于后端“学生工作区”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { config } from "../../config/index.js";
import {
  applyWorkspaceStructurePlan,
  extractWorkspaceAttachmentSavePlan,
  extractCurrentMarkdownSavePlan,
  extractWorkspaceDeletePlan,
  extractWorkspaceFileExportPlan,
  extractWorkspaceStructurePlan,
  shouldUseDeterministicWorkspaceScaffold
} from "./scaffold.service.js";

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("extracts a quoted directory name from a natural-language create-directory prompt", () => {
  const prompt = '帮我在工作区创建一个目录，名字叫"prompts"';
  const plan = extractWorkspaceStructurePlan(prompt);

  assert.deepEqual(plan?.directories, ["prompts"]);
  assert.equal(plan?.files.length, 0);
  assert.equal(shouldUseDeterministicWorkspaceScaffold(prompt, plan), true);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("extracts an explicitly named Chinese directory", () => {
  const prompt = "请创建一个目录，名字叫实验一";
  const plan = extractWorkspaceStructurePlan(prompt);

  assert.deepEqual(plan?.directories, ["实验一"]);
  assert.equal(plan?.files.length, 0);
  assert.equal(shouldUseDeterministicWorkspaceScaffold(prompt, plan), true);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("does not treat a vague Chinese directory description as a path", () => {
  const prompt = "你可以创建所有工作目录，为开发做好准备";
  const plan = extractWorkspaceStructurePlan(prompt);

  assert.equal(plan, null);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("extracts only direct directory deletion commands", () => {
  assert.deepEqual(extractWorkspaceDeletePlan("请删除 logs 目录"), { directories: ["logs"] });
  assert.deepEqual(extractWorkspaceDeletePlan("delete directory tmp"), { directories: ["tmp"] });
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("does not treat markdown rule text as a directory deletion request", () => {
  const prompt = [
    "# MyVibeOS前置约束",
    "",
    "- `make clean`",
    "  - 删除 `build/`",
    "  - 删除根目录生成的 tag/cscope 文件",
    "",
    "## 本文件使用方式",
    "",
    "将内容存成 `前置约束.md` 文件，并将该文件放置在工程的根目录。"
  ].join("\n");

  assert.equal(extractWorkspaceDeletePlan(prompt), null);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("extracts current markdown save request from pasted document", () => {
  const prompt = [
    "# Project Constraints",
    "",
    "- keep this document",
    "",
    "## Usage",
    "",
    "将内容存成 `前置约束.md` 文件，并将该文件放置在工程的根目录。"
  ].join("\n");
  const plan = extractCurrentMarkdownSavePlan(prompt);

  assert.equal(plan?.filePath, "前置约束.md");
  assert.match(plan?.content ?? "", /Project Constraints/);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("extracts direct directory creation requests without relying on a trailing slash", () => {
  const prompt = "create a directory named notes";
  const plan = extractWorkspaceStructurePlan(prompt);

  assert.deepEqual(plan?.directories, ["notes"]);
  assert.equal(plan?.files.length, 0);
  assert.equal(shouldUseDeterministicWorkspaceScaffold(prompt, plan), true);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("extracts common direct file creation requests", () => {
  const cases: Array<{ prompt: string; files: string[]; directories?: string[]; deterministic?: boolean }> = [
    { prompt: "请创建一个 README.md 文件", files: ["README.md"], deterministic: true },
    { prompt: "新建一个名为 notes.txt 的文件", files: ["notes.txt"], deterministic: true },
    { prompt: "创建文件，名字叫 config.json", files: ["config.json"], deterministic: true },
    { prompt: "create file Makefile", files: ["Makefile"], deterministic: true },
    { prompt: "add README.txt file", files: ["README.txt"], deterministic: true },
    { prompt: "创建 docs/ 目录，并创建 README.md 文件", directories: ["docs"], files: ["README.md"], deterministic: true },
    { prompt: "创建一个目录，名字叫 src，并创建一个文件 README.md", directories: ["src"], files: ["README.md"], deterministic: true },
    { prompt: "创建一个名为 hello.c 的 C 文件，内容是打印 \"Hello\"", files: ["hello.c"], deterministic: false }
  ];

  for (const item of cases) {
    const plan = extractWorkspaceStructurePlan(item.prompt);
    assert.deepEqual(plan?.directories ?? [], item.directories ?? [], item.prompt);
    assert.deepEqual(plan?.files.map((file) => file.path).sort(), item.files.sort(), item.prompt);
    assert.equal(shouldUseDeterministicWorkspaceScaffold(item.prompt, plan), item.deterministic, item.prompt);
  }
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("extracts explicitly listed short project scaffold items without entering code generation", () => {
  const prompt = [
    "为 MyVibeOS 创建最小项目骨架。只需要做三件事：",
    "1. 创建 src/ 目录",
    "2. 创建 Makefile，包含 run / clean / cscope 三个 target",
    "3. 创建 README.md，写一句项目简介",
    "",
    "不要写任何 C 代码，不要创建 kernel_main。"
  ].join("\n");
  const plan = extractWorkspaceStructurePlan(prompt);

  assert.deepEqual(plan?.directories, ["src"]);
  assert.deepEqual(plan?.files.map((file) => file.path).sort(), ["Makefile", "README.md"]);
  assert.match(plan?.files.find((file) => file.path === "Makefile")?.content ?? "", /\.PHONY: run clean cscope/);
  assert.match(plan?.files.find((file) => file.path === "README.md")?.content ?? "", /^# MyVibeOS/m);
  assert.equal(shouldUseDeterministicWorkspaceScaffold(prompt, plan), true);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("supports generic scaffold-only prompts without course-specific anchoring", () => {
  const prompt = [
    "为 DataLab 创建基础项目骨架。只需要做三件事：",
    "1. 创建 src/ 目录",
    "2. 创建 Makefile，包含 run / clean 两个 target",
    "3. 创建 README.md，写一句项目简介",
    "",
    "不要写任何 Python 代码，不要创建 main 函数。"
  ].join("\n");
  const plan = extractWorkspaceStructurePlan(prompt);

  assert.deepEqual(plan?.directories, ["src"]);
  assert.deepEqual(plan?.files.map((file) => file.path).sort(), ["Makefile", "README.md"]);
  assert.match(plan?.files.find((file) => file.path === "README.md")?.content ?? "", /^# DataLab/m);
  assert.equal(shouldUseDeterministicWorkspaceScaffold(prompt, plan), true);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("applies scaffold-only project skeleton to workspace", async () => {
  const previousWorkspaceRoot = config.WORKSPACE_ROOT;
  const workspaceParent = await fs.mkdtemp(path.join(os.tmpdir(), "courseworks-scaffold-root-"));
  config.WORKSPACE_ROOT = workspaceParent;
  const root = path.join(workspaceParent, "student-workspace");
  await fs.mkdir(root, { recursive: true });
  try {
    const prompt = [
      "为 MyVibeOS 创建最小项目骨架。只需要做三件事：",
      "1. 创建 src/ 目录",
      "2. 创建 Makefile，包含 run / clean / cscope 三个 target",
      "3. 创建 README.md，写一句项目简介",
      "",
      "不要写任何 C 代码，不要创建 kernel_main。"
    ].join("\n");
    const plan = extractWorkspaceStructurePlan(prompt);
    assert.ok(plan);
    assert.equal(shouldUseDeterministicWorkspaceScaffold(prompt, plan), true);

    const result = await applyWorkspaceStructurePlan(root, plan);

    assert.deepEqual(result.createdDirectories, ["src"]);
    assert.deepEqual(result.createdFiles.sort(), ["Makefile", "README.md"]);
    assert.match(await fs.readFile(path.join(root, "Makefile"), "utf8"), /\.PHONY: run clean cscope/);
    assert.match(await fs.readFile(path.join(root, "README.md"), "utf8"), /^# MyVibeOS/m);
  } finally {
    config.WORKSPACE_ROOT = previousWorkspaceRoot;
    await fs.rm(workspaceParent, { recursive: true, force: true });
  }
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("does not infer default project scaffold files from a vague scaffold request", () => {
  const prompt = "请为这个课程创建最小项目骨架。";
  const plan = extractWorkspaceStructurePlan(prompt);

  assert.equal(plan, null);
  assert.equal(shouldUseDeterministicWorkspaceScaffold(prompt, plan), false);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("does not scaffold a Makefile request with concrete target semantics", () => {
  const prompt = "创建一个名为 hello.c 的 C 文件，内容是打印 \"Hello from MyVibeOS\"，并创建对应的 Makefile（包含 run 和 clean 两个 target）。";
  const plan = extractWorkspaceStructurePlan(prompt);

  assert.equal(shouldUseDeterministicWorkspaceScaffold(prompt, plan), false);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("does not create a placeholder Makefile when concrete targets are requested", () => {
  const prompt = "请创建 Makefile，包含 run 和 clean 两个 target。";
  const plan = extractWorkspaceStructurePlan(prompt);

  assert.equal(plan?.files.some((file) => file.path === "Makefile"), true);
  assert.equal(shouldUseDeterministicWorkspaceScaffold(prompt, plan), false);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("still supports explicit backtick directory tokens", () => {
  const prompt = "工程目录约束：根目录应包含 `kernel/` 和 `user/`";
  const plan = extractWorkspaceStructurePlan(prompt);

  assert.deepEqual(plan?.directories, ["kernel", "user"]);
  assert.equal(shouldUseDeterministicWorkspaceScaffold(prompt, plan), true);
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("extracts the target directory for saving uploaded attachments into workspace", () => {
  assert.deepEqual(
    extractWorkspaceAttachmentSavePlan("请把附件中的文件存放到工作区的prompts目录"),
    { directory: "prompts" }
  );
  assert.deepEqual(
    extractWorkspaceAttachmentSavePlan("copy the uploaded attachment into workspace prompts folder"),
    { directory: "prompts" }
  );
});

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("extracts workspace file export requests for chat download", () => {
  assert.deepEqual(
    extractWorkspaceFileExportPlan("请将prompts中的1.1.md文件拷贝到聊天窗口，已供我下载。"),
    { filePath: "prompts/1.1.md" }
  );
  assert.deepEqual(
    extractWorkspaceFileExportPlan("export workspace file `prompts/notes.md` for download"),
    { filePath: "prompts/notes.md" }
  );
});
