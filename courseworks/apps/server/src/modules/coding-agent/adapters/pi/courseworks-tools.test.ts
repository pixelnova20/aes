/**
 * 文件作用：验证后端“Coding Agent 与 Pi 适配”业务模块中的关键行为和回归场景。
 * 模块位置：`apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.test.ts`，属于后端“Coding Agent 与 Pi 适配”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  SANDBOX_UPLOADS_PATH,
  uploadsRoot,
} from "../../../artifacts/index.js";
import {
  createCourseworksReviewToolDefinitions,
  createCourseworksToolDefinitions,
} from "./courseworks-tools.js";

/**
 * 功能：验证当前 test/describe 声明对应的行为场景。
 * 输入：测试框架提供测试上下文，测试体构造该场景所需的数据。
 * 输出：断言通过时测试成功；断言或异步操作失败时由 Node 测试运行器报告错误。
 * 调用关系：由 Node test runner 在执行当前测试文件时调用。
 */
test("Courseworks Pi file tools write inside the workspace and reject traversal", async () => {
  const workspacePath = path.join(
    process.env.WORKSPACE_ROOT!,
    "pi-tools",
    "workspace",
  );
  await fs.rm(path.dirname(workspacePath), { recursive: true, force: true });
  await fs.mkdir(workspacePath, { recursive: true });
  const mutations: Array<{ eventType: string; path: string; beforeSha256?: string; afterSha256?: string }> = [];
  const tools = createCourseworksToolDefinitions(workspacePath, {
    onMutation: async (mutation) => {
      mutations.push(mutation);
    },
  });
  const write = tools.find((tool) => tool.name === "write");
  const read = tools.find((tool) => tool.name === "read");
  assert.ok(write);
  assert.ok(read);

  await write.execute(
    "write-inside",
    { path: "test/hello.c", content: "int main(void) { return 0; }\n" },
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(
    await fs.readFile(path.join(workspacePath, "test/hello.c"), "utf8"),
    "int main(void) { return 0; }\n",
  );
  await write.execute(
    "write-logical-absolute",
    {
      path: "/home/runner/project/test/logical-path.txt",
      content: "logical-workspace-path\n",
    },
    undefined,
    undefined,
    undefined as never,
  );
  assert.equal(
    await fs.readFile(path.join(workspacePath, "test/logical-path.txt"), "utf8"),
    "logical-workspace-path\n",
  );
  assert.equal(mutations.length, 3);
  assert.deepEqual(mutations.map((mutation) => [mutation.eventType, mutation.path]), [
    ["directory.create", "test"],
    ["file.write", "test/hello.c"],
    ["file.write", "test/logical-path.txt"],
  ]);
  assert.ok(mutations.filter((mutation) => mutation.eventType === "file.write").every((mutation) => mutation.afterSha256));

  const result = await read.execute(
    "read-inside",
    { path: "test/hello.c" },
    undefined,
    undefined,
    undefined as never,
  );
  assert.match(
    result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
    /int main/,
  );
  const logicalPathResult = await read.execute(
    "read-logical-absolute",
    { path: "/home/runner/project/test/logical-path.txt" },
    undefined,
    undefined,
    undefined as never,
  );
  assert.match(
    logicalPathResult.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
    /logical-workspace-path/,
  );

  await fs.mkdir(uploadsRoot(workspacePath), { recursive: true });
  await fs.writeFile(
    path.join(uploadsRoot(workspacePath), "example.txt"),
    "attachment-content\n",
  );
  const attachment = await read.execute(
    "read-attachment",
    { path: "../.uploads/example.txt" },
    undefined,
    undefined,
    undefined as never,
  );
  assert.match(
    attachment.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
    /attachment-content/,
  );
  const absoluteAttachment = await read.execute(
    "read-attachment-container-absolute",
    { path: `${SANDBOX_UPLOADS_PATH}/example.txt` },
    undefined,
    undefined,
    undefined as never,
  );
  assert.match(
    absoluteAttachment.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
    /attachment-content/,
  );

  await fs.writeFile(
    path.join(uploadsRoot(workspacePath), "example.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  );
  const imageAttachment = await read.execute(
    "read-image-attachment",
    { path: `${SANDBOX_UPLOADS_PATH}/example.png` },
    undefined,
    undefined,
    undefined as never,
  );
  assert.ok(imageAttachment.content.some((part) => part.type === "image"));

  await assert.rejects(
    write.execute(
      "write-outside",
      { path: "../outside.txt", content: "blocked" },
      undefined,
      undefined,
      undefined as never,
    ),
    /outside the current workspace/,
  );
  await assert.rejects(
    write.execute(
      "write-attachment",
      { path: "../.uploads/example.txt", content: "blocked" },
      undefined,
      undefined,
      undefined as never,
    ),
    /outside the current workspace/,
  );
});

test("Courseworks exposes optional QEMU display tools without replacing text tools", async () => {
  const workspacePath = path.join(process.env.WORKSPACE_ROOT!, "pi-display-tools", "workspace");
  await fs.mkdir(workspacePath, { recursive: true });
  const tools = createCourseworksToolDefinitions(workspacePath, { displaySessionId: "test-display" });
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "read",
      "bash",
      "edit",
      "write",
      "start_qemu_display",
      "capture_qemu_display",
      "send_qemu_display_input",
      "stop_qemu_display",
    ],
  );
  const start = tools.find((tool) => tool.name === "start_qemu_display");
  assert.ok(start);
  assert.match(start.description, /Optionally/);
  assert.doesNotMatch(start.description, /make run-gui/i);
});

test("review tools traverse only approved student workspace links and remain read-only", async () => {
  const root = path.join(process.env.WORKSPACE_ROOT!, "pi-review-tools");
  const teacherProject = path.join(root, "teacher", "project");
  const auditPath = path.join(root, "teacher", "audit");
  const studentRoot = path.join(root, "student-approved");
  const unapprovedRoot = path.join(root, "student-unapproved");
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(teacherProject, { recursive: true });
  await fs.mkdir(auditPath, { recursive: true });
  await fs.mkdir(path.join(studentRoot, ".eva_history"), { recursive: true });
  await fs.mkdir(unapprovedRoot, { recursive: true });
  await fs.writeFile(path.join(auditPath, "match.md"), "2401001 -> student-approved\n");
  await fs.writeFile(path.join(studentRoot, ".eva_history", "session-history.md"), "Agent Run 1: completed\n");
  await fs.writeFile(path.join(unapprovedRoot, "secret.txt"), "not readable\n");
  await fs.symlink(path.relative(auditPath, studentRoot), path.join(auditPath, "2401001"), "dir");
  await fs.symlink(path.relative(auditPath, unapprovedRoot), path.join(auditPath, "rogue"), "dir");

  const tools = createCourseworksReviewToolDefinitions(auditPath, {
    storageWorkspacePath: teacherProject,
    readableWorkspaceRoots: [studentRoot],
  });
  assert.deepEqual(tools.map((tool) => tool.name), ["ls", "grep", "read"]);
  const ls = tools.find((tool) => tool.name === "ls");
  const read = tools.find((tool) => tool.name === "read");
  assert.ok(ls);
  assert.ok(read);

  const listing = await ls.execute("list-audit", { path: "." }, undefined, undefined, undefined as never);
  assert.match(listing.content.map((part) => part.type === "text" ? part.text : "").join(""), /2401001\//);
  const history = await read.execute(
    "read-history",
    { path: "2401001/.eva_history/session-history.md" },
    undefined,
    undefined,
    undefined as never,
  );
  assert.match(history.content.map((part) => part.type === "text" ? part.text : "").join(""), /Agent Run 1/);
  await assert.rejects(
    read.execute("read-rogue", { path: "rogue/secret.txt" }, undefined, undefined, undefined as never),
    /unapproved student workspace/,
  );
  await assert.rejects(
    read.execute("read-outside", { path: "/etc/passwd" }, undefined, undefined, undefined as never),
    /outside the teacher review workspace/,
  );
});
