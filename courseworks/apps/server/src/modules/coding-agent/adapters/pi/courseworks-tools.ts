/**
 * 文件作用：实现后端“Coding Agent 与 Pi 适配”业务模块中的 `hostToolPath`、`workspaceRelativePath`、`validateWorkspacePath` 等能力。
 * 模块位置：`apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts`，属于后端“Coding Agent 与 Pi 适配”业务模块。
 * 重要函数：`hostToolPath()` 负责处理`host` `tool` 路径；`workspaceRelativePath()` 负责处理工作区 `relative` 路径；`validateWorkspacePath()` 负责校验工作区 路径；`validateReadablePath()` 负责校验`readable` 路径；`createCourseworksToolDefinitions()` 负责创建`courseworks` `tool` 定义列表；`courseworksToolInfo()` 负责处理`courseworks` `tool` `info`。
 */
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  captureGraphicalQemuDisplay,
  sendGraphicalQemuInput,
  sendGraphicalQemuKeys,
  startGraphicalQemuSession,
  stopGraphicalQemuSession,
  waitForGraphicalQemuSession,
  runSandboxCommand,
} from "../../../execution/index.js";
import {
  SANDBOX_UPLOADS_PATH,
  uploadsRoot,
} from "../../../artifacts/index.js";
import {
  assertNoSymlinkPath,
  ensureSafeParentDirectory,
  safePathResolve,
} from "../../../workspaces/index.js";
import type { AgentToolInfo } from "../../coding-agent-runtime.js";
import type { WorkspaceMutation } from "../../../evaluation-history/index.js";
import { assertWorkspaceWriteAllowed } from "../../../workspaces/index.js";

export const SANDBOX_WORKSPACE_PATH = "/home/runner/project";

async function sha256File(filePath: string) {
  try {
    return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  } catch {
    return undefined;
  }
}

async function recordMutation(onMutation: ((mutation: WorkspaceMutation) => Promise<void>) | undefined, mutation: WorkspaceMutation) {
  if (!onMutation) return;
  try {
    await onMutation(mutation);
  } catch (error) {
    console.error("[workspace-activity]", error instanceof Error ? error.message : error);
  }
}

async function detectImageMimeType(candidate: string) {
  const buffer = (await fs.readFile(candidate)).subarray(0, 16);
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer.subarray(0, 3).toString("ascii") === "GIF") {
    return "image/gif";
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return null;
}

/**
 * 功能：处理`host` `tool` 路径。
 * 输入：`workspacePath`（string）提供工作区 路径。 `candidate`（string）提供candidate。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:workspaceRelativePath()`、`apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:validateReadablePath()` 调用；内部调用 `resolve()`、`relative()`、`startsWith()`、`isAbsolute()`、`uploadsRoot()`。
 */
function hostToolPath(workspacePath: string, candidate: string) {
  const resolved = path.resolve(candidate);
  const workspaceRelative = path.relative(SANDBOX_WORKSPACE_PATH, resolved);
  if (!workspaceRelative.startsWith("..") && !path.isAbsolute(workspaceRelative)) {
    return path.resolve(workspacePath, workspaceRelative);
  }
  const uploadsRelative = path.relative(SANDBOX_UPLOADS_PATH, resolved);
  if (!uploadsRelative.startsWith("..") && !path.isAbsolute(uploadsRelative)) {
    return path.resolve(uploadsRoot(workspacePath), uploadsRelative);
  }
  return candidate;
}

/**
 * 功能：处理工作区 `relative` 路径。
 * 输入：`workspacePath`（string）提供工作区 路径。 `candidate`（string）提供candidate。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:validateWorkspacePath()`、`apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:writeFile()`、`apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:mkdir()` 调用；内部调用 `resolve()`、`hostToolPath()`、`relative()`、`startsWith()`、`isAbsolute()`、`safePathResolve()`。
 */
function workspaceRelativePath(workspacePath: string, candidate: string) {
  const root = path.resolve(workspacePath);
  const resolved = path.resolve(hostToolPath(workspacePath, candidate));
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Path is outside the current workspace.");
  }
  safePathResolve(workspacePath, relative);
  return relative || ".";
}

/**
 * 功能：校验工作区 路径。
 * 输入：`workspacePath`（string）提供工作区 路径。 `candidate`（string）提供candidate。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:readFile()`、`apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:access()` 调用；内部调用 `workspaceRelativePath()`、`assertNoSymlinkPath()`、`safePathResolve()`。
 */
async function validateWorkspacePath(workspacePath: string, candidate: string) {
  const relative = workspaceRelativePath(workspacePath, candidate);
  await assertNoSymlinkPath(workspacePath, relative);
  return safePathResolve(workspacePath, relative);
}

/**
 * 功能：校验`readable` 路径。
 * 输入：`workspacePath`（string）提供工作区 路径。 `candidate`（string）提供candidate。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:readFile()`、`apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:access()` 调用；内部调用 `resolve()`、`hostToolPath()`、`uploadsRoot()`、`relative()`、`startsWith()`、`isAbsolute()`。
 */
async function validateReadablePath(workspacePath: string, candidate: string) {
  const resolved = path.resolve(hostToolPath(workspacePath, candidate));
  const workspaceRoot = path.resolve(workspacePath);
  const attachmentRoot = path.resolve(uploadsRoot(workspacePath));
  /**
   * 功能：判断是否为`inside`。
   * 输入：`root`（string）提供根目录。
   * 输出：返回判断或校验结果；校验失败时可能抛出异常。
   * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:validateReadablePath()` 调用；内部调用 `relative()`、`startsWith()`、`isAbsolute()`。
   */
  const isInside = (root: string) => {
    const relative = path.relative(root, resolved);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  if (!isInside(workspaceRoot) && !isInside(attachmentRoot)) {
    throw new Error("Read path is outside the workspace and attachment directory.");
  }
  const relative = path.relative(workspaceRoot, resolved);
  await assertNoSymlinkPath(workspacePath, relative);
  return safePathResolve(workspacePath, relative);
}

function isInsidePath(root: string, candidate: string) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function reviewHostPath(auditPath: string, storageWorkspacePath: string, candidate: string) {
  const resolved = path.resolve(candidate);
  const workspaceRelative = path.relative(SANDBOX_WORKSPACE_PATH, resolved);
  if (!workspaceRelative.startsWith("..") && !path.isAbsolute(workspaceRelative)) {
    return path.resolve(auditPath, workspaceRelative);
  }
  const uploadsRelative = path.relative(SANDBOX_UPLOADS_PATH, resolved);
  if (!uploadsRelative.startsWith("..") && !path.isAbsolute(uploadsRelative)) {
    return path.resolve(uploadsRoot(storageWorkspacePath), uploadsRelative);
  }
  return resolved;
}

async function validateReviewReadablePath(
  auditPath: string,
  storageWorkspacePath: string,
  readableWorkspaceRoots: string[],
  candidate: string,
) {
  const resolved = reviewHostPath(auditPath, storageWorkspacePath, candidate);
  const resolvedAuditPath = path.resolve(auditPath);
  const attachmentRoot = path.resolve(uploadsRoot(storageWorkspacePath));
  const isAuditPath = isInsidePath(resolvedAuditPath, resolved);
  const isAttachmentPath = isInsidePath(attachmentRoot, resolved);
  if (!isAuditPath && !isAttachmentPath) {
    throw new Error("Read path is outside the teacher review workspace.");
  }

  const relative = path.relative(isAuditPath ? resolvedAuditPath : attachmentRoot, resolved);
  if (relative.split(path.sep).some((segment) => [".git", ".env", ".checkpoints", "node_modules"].includes(segment))) {
    throw new Error("Blocked review path.");
  }

  const realPath = await fs.realpath(resolved);
  if (isAttachmentPath) {
    const realAttachmentRoot = await fs.realpath(attachmentRoot);
    if (!isInsidePath(realAttachmentRoot, realPath)) throw new Error("Attachment path crosses an unapproved symbolic link.");
    return realPath;
  }

  const realAuditPath = await fs.realpath(resolvedAuditPath);
  const approvedRoots = await Promise.all(readableWorkspaceRoots.map((root) => fs.realpath(root)));
  if (!isInsidePath(realAuditPath, realPath) && !approvedRoots.some((root) => isInsidePath(root, realPath))) {
    throw new Error("Review path crosses an unapproved student workspace link.");
  }
  return realPath;
}

export function createCourseworksReviewToolDefinitions(
  auditPath: string,
  options: {
    storageWorkspacePath: string;
    readableWorkspaceRoots: string[];
  },
) {
  const validate = (candidate: string) => validateReviewReadablePath(
    auditPath,
    options.storageWorkspacePath,
    options.readableWorkspaceRoots,
    candidate,
  );
  const read = createReadToolDefinition(auditPath, {
    operations: {
      async readFile(candidate) {
        return fs.readFile(await validate(candidate));
      },
      async access(candidate) {
        await fs.access(await validate(candidate), constants.R_OK);
      },
      detectImageMimeType: async (candidate) => detectImageMimeType(await validate(candidate)),
    },
  });
  const ls = createLsToolDefinition(auditPath, {
    operations: {
      async exists(candidate) {
        return validate(candidate).then(() => true, () => false);
      },
      async stat(candidate) {
        return fs.stat(await validate(candidate));
      },
      async readdir(candidate) {
        return fs.readdir(await validate(candidate));
      },
    },
  });
  const grep = createGrepToolDefinition(auditPath, {
    operations: {
      async isDirectory(candidate) {
        return (await fs.stat(await validate(candidate))).isDirectory();
      },
      async readFile(candidate) {
        return fs.readFile(await validate(candidate), "utf8");
      },
    },
  });
  return [defineTool(ls), defineTool(grep), defineTool(read)];
}

/**
 * 功能：创建`courseworks` `tool` 定义列表。
 * 输入：`workspacePath`（string）提供工作区 路径。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.test.ts 顶层流程`、`apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:createPiSession()` 调用；内部调用 `createReadToolDefinition()`、`readFile()`、`validateReadablePath()`、`access()`、`createEditToolDefinition()`、`validateWorkspacePath()`。
 */
export function createCourseworksToolDefinitions(
  workspacePath: string,
  toolOptions: { displaySessionId?: string; workspaceId?: string; runId?: string; userId?: string; onMutation?: (mutation: WorkspaceMutation) => Promise<void> } = {},
) {
  const displaySessionId = toolOptions.displaySessionId ?? `pi-display-${randomUUID()}`;
  const read = createReadToolDefinition(workspacePath, {
    operations: {
            /**
             * 功能：读取文件。
             * 输入：`candidate`提供candidate。
             * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
             * 调用关系：由 `apps/server/src/application/ai-settings/ai-settings-application.service.ts:runDirectAiChat()`、`apps/server/src/application/workspace/workspace-application.service.ts:readWorkspaceFile()`、`apps/server/src/modules/artifacts/artifact-store.ts:loadArtifactIndex()`、`apps/server/src/modules/artifacts/upload-store.ts:loadIndex()`、`apps/server/src/modules/artifacts/upload-store.ts:buildUploadContext()` 调用；内部调用 `readFile()`、`validateReadablePath()`。
             */
            async readFile(candidate) {
        return fs.readFile(await validateReadablePath(workspacePath, candidate));
      },
            /**
             * 功能：处理`access`。
             * 输入：`candidate`提供candidate。
             * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
             * 调用关系：由 `apps/server/src/modules/code-navigation/code-navigation.service.ts:loadTagsFile()`、`apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:access()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.test.ts 顶层流程`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:openPiSession()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:readPiSessionHistory()` 调用；内部调用 `access()`、`validateReadablePath()`。
             */
            async access(candidate) {
        await fs.access(await validateReadablePath(workspacePath, candidate), constants.R_OK);
      },
            detectImageMimeType: async (candidate) => detectImageMimeType(
              await validateReadablePath(workspacePath, candidate),
            ),
    },
  });

  const edit = createEditToolDefinition(workspacePath, {
    operations: {
            /**
             * 功能：读取文件。
             * 输入：`candidate`提供candidate。
             * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
             * 调用关系：由 `apps/server/src/application/ai-settings/ai-settings-application.service.ts:runDirectAiChat()`、`apps/server/src/application/workspace/workspace-application.service.ts:readWorkspaceFile()`、`apps/server/src/modules/artifacts/artifact-store.ts:loadArtifactIndex()`、`apps/server/src/modules/artifacts/upload-store.ts:loadIndex()`、`apps/server/src/modules/artifacts/upload-store.ts:buildUploadContext()` 调用；内部调用 `readFile()`、`validateWorkspacePath()`。
             */
            async readFile(candidate) {
        return fs.readFile(await validateWorkspacePath(workspacePath, candidate));
      },
            /**
             * 功能：写入文件。
             * 输入：`candidate`提供candidate。 `content`提供content。
             * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
             * 调用关系：由 `apps/server/scripts/sync-model-catalog.mjs 顶层流程`、`apps/server/src/application/agent/commands/inbound.test.ts:setupWorkspace()`、`apps/server/src/application/workspace/workspace-application.service.ts:createWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:saveWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:uploadWorkspaceFile()` 调用；内部调用 `workspaceRelativePath()`、`ensureSafeParentDirectory()`、`assertNoSymlinkPath()`、`writeFile()`、`safePathResolve()`。
             */
            async writeFile(candidate, content) {
        const fullPath = await validateWorkspacePath(workspacePath, candidate);
        const beforeSha256 = await sha256File(fullPath);
        const relative = workspaceRelativePath(workspacePath, candidate);
        await ensureSafeParentDirectory(workspacePath, relative);
        await assertNoSymlinkPath(workspacePath, relative);
        let previousSize = 0;
        try { previousSize = (await fs.stat(fullPath)).size; } catch { /* new file */ }
        await assertWorkspaceWriteAllowed(workspacePath, Math.max(0, Buffer.byteLength(content, "utf8") - previousSize));
        await fs.writeFile(fullPath, content, "utf8");
        await recordMutation(toolOptions.onMutation, { eventType: "file.write", path: relative, beforeSha256, afterSha256: await sha256File(fullPath) });
      },
            /**
             * 功能：处理`access`。
             * 输入：`candidate`提供candidate。
             * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
             * 调用关系：由 `apps/server/src/modules/code-navigation/code-navigation.service.ts:loadTagsFile()`、`apps/server/src/modules/coding-agent/adapters/pi/courseworks-tools.ts:access()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.test.ts 顶层流程`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:openPiSession()`、`apps/server/src/modules/coding-agent/adapters/pi/pi-session-store.ts:readPiSessionHistory()` 调用；内部调用 `access()`、`validateWorkspacePath()`。
             */
            async access(candidate) {
        await fs.access(
          await validateWorkspacePath(workspacePath, candidate),
          constants.R_OK | constants.W_OK,
        );
      },
    },
  });

  const write = createWriteToolDefinition(workspacePath, {
    operations: {
            /**
             * 功能：写入文件。
             * 输入：`candidate`提供candidate。 `content`提供content。
             * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
             * 调用关系：由 `apps/server/scripts/sync-model-catalog.mjs 顶层流程`、`apps/server/src/application/agent/commands/inbound.test.ts:setupWorkspace()`、`apps/server/src/application/workspace/workspace-application.service.ts:createWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:saveWorkspaceFile()`、`apps/server/src/application/workspace/workspace-application.service.ts:uploadWorkspaceFile()` 调用；内部调用 `workspaceRelativePath()`、`ensureSafeParentDirectory()`、`assertNoSymlinkPath()`、`writeFile()`、`safePathResolve()`。
             */
            async writeFile(candidate, content) {
        const fullPath = safePathResolve(workspacePath, workspaceRelativePath(workspacePath, candidate));
        const beforeSha256 = await sha256File(fullPath);
        const relative = workspaceRelativePath(workspacePath, candidate);
        await ensureSafeParentDirectory(workspacePath, relative);
        await assertNoSymlinkPath(workspacePath, relative);
        let previousSize = 0;
        try { previousSize = (await fs.stat(fullPath)).size; } catch { /* new file */ }
        await assertWorkspaceWriteAllowed(workspacePath, Math.max(0, Buffer.byteLength(content, "utf8") - previousSize));
        await fs.writeFile(fullPath, content, "utf8");
        await recordMutation(toolOptions.onMutation, { eventType: "file.write", path: relative, beforeSha256, afterSha256: await sha256File(fullPath) });
      },
            /**
             * 功能：处理`mkdir`。
             * 输入：`candidate`提供candidate。
             * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
             * 调用关系：由 `apps/server/scripts/sync-model-catalog.mjs 顶层流程`、`apps/server/src/application/agent/commands/inbound.test.ts:setupWorkspace()`、`apps/server/src/application/workspace/workspace-application.service.ts:createWorkspaceDirectory()`、`apps/server/src/modules/artifacts/artifact-store.ts:ensureArtifactRoots()`、`apps/server/src/modules/artifacts/artifact-store.ts:createConsumedArtifacts()` 调用；内部调用 `workspaceRelativePath()`、`assertNoSymlinkPath()`、`mkdir()`、`safePathResolve()`。
             */
            async mkdir(candidate) {
        const relative = workspaceRelativePath(workspacePath, candidate);
        await assertNoSymlinkPath(workspacePath, relative);
        const fullPath = safePathResolve(workspacePath, relative);
        let existed = true;
        try {
          await fs.access(fullPath, constants.F_OK);
        } catch {
          existed = false;
        }
        await fs.mkdir(fullPath, { recursive: true });
        if (!existed) await recordMutation(toolOptions.onMutation, { eventType: "directory.create", path: relative });
      },
    },
  });

  const bash = createBashToolDefinition(workspacePath, {
    exposeSessionEnvironment: false,
    operations: {
            /**
             * 功能：处理`exec`。
             * 输入：`command`提供命令。 `_cwd`提供cwd。 `options`提供options。
             * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
             * 调用关系：由本模块其他函数、应用编排层、协议适配层或测试按需调用；内部调用 `runSandboxCommand()`、`replaceAll()`、`resolve()`。
             */
            async exec(command, _cwd, options) {
        return runSandboxCommand({
          workspacePath,
          command: command.replaceAll(path.resolve(workspacePath), SANDBOX_WORKSPACE_PATH),
          timeoutSeconds: options.timeout,
          signal: options.signal,
          onData: options.onData,
          metadata: { workspaceId: toolOptions.workspaceId, runId: toolOptions.runId, userId: toolOptions.userId },
        });
      },
    },
  });
  bash.description =
    "Execute a shell command in the isolated Courseworks build container. " +
    "The workspace is mounted as the working directory; host files and network access are unavailable.";
  bash.promptGuidelines = [
    "Use bash to compile and test changes in the isolated Courseworks container.",
    `The bash working directory is ${SANDBOX_WORKSPACE_PATH}; use relative paths whenever possible.`,
    "Run a relevant build or test after changing code whenever the project provides one.",
  ];

  const startQemuDisplay = defineTool({
    name: "start_qemu_display",
    label: "Start QEMU display",
    description:
      "Optionally start a QEMU command when inspecting graphical guest output is relevant. " +
      "You choose the project command; no Make target or graphical output is required by Courseworks. " +
      "The session runs independently from the ordinary bash tool and is resource-limited.",
    parameters: Type.Object({
      command: Type.String({
        minLength: 1,
        maxLength: 8192,
        description: "Project command that builds and/or starts QEMU, such as a Make target, script, or direct QEMU invocation.",
      }),
      wait_seconds: Type.Optional(Type.Number({
        minimum: 0,
        maximum: 30,
        description: "Seconds to wait for QEMU/QMP readiness before returning. Default: 3.",
      })),
      timeout_seconds: Type.Optional(Type.Number({
        minimum: 10,
        maximum: 600,
        description: "Maximum lifetime of this optional display session. Default: 180.",
      })),
    }),
    executionMode: "sequential" as const,
    async execute(_toolCallId, params) {
      await startGraphicalQemuSession({
        sessionId: displaySessionId,
        workspacePath,
        command: params.command,
        timeoutSeconds: params.timeout_seconds,
      });
      const state = await waitForGraphicalQemuSession(displaySessionId, params.wait_seconds ?? 3);
      const summary = state.qmpReady
        ? "QEMU control channel is ready; the framebuffer can be captured."
        : state.status === "running"
          ? "The command is still running, but QEMU graphics are not ready yet. It may still be building or may be running without the Courseworks QMP hook."
          : "The command exited before a QEMU graphics channel became ready.";
      return {
        content: [{ type: "text" as const, text: `${summary}\n\nStatus: ${state.status}\nRecent output:\n${state.output.slice(-4000) || "(none)"}` }],
        details: { status: state.status, qmpReady: state.qmpReady, exitCode: state.exitCode },
      };
    },
  });

  const captureQemuDisplay = defineTool({
    name: "capture_qemu_display",
    label: "Capture QEMU display",
    description:
      "Capture the actual QEMU framebuffer for the optional display session. " +
      "Returns factual pixel metrics and a compact ASCII preview suitable for text-only models; a uniform or dark frame is diagnostic information, not a project failure.",
    parameters: Type.Object({}),
    executionMode: "sequential" as const,
    async execute() {
      const capture = await captureGraphicalQemuDisplay(displaySessionId);
      const changed = capture.changedPixelRatio === null
        ? "not available (first capture)"
        : String(capture.changedPixelRatio);
      return {
        content: [{
          type: "text" as const,
          text: [
            `Captured QEMU framebuffer: ${capture.width}x${capture.height}`,
            `Frame SHA-256: ${capture.frameHash}`,
            `Mean brightness: ${capture.meanBrightness}/255`,
            `Dark pixel ratio: ${capture.darkPixelRatio}`,
            `Sampled unique colors: ${capture.uniqueColorEstimate}`,
            `Uniform frame: ${capture.uniformFrame}`,
            `Changed pixel ratio since previous capture: ${changed}`,
            "ASCII luminance preview:",
            capture.asciiPreview || "(uniform dark frame)",
          ].join("\n"),
        }],
        details: {
          width: capture.width,
          height: capture.height,
          frameHash: capture.frameHash,
          meanBrightness: capture.meanBrightness,
          darkPixelRatio: capture.darkPixelRatio,
          uniqueColorEstimate: capture.uniqueColorEstimate,
          uniformFrame: capture.uniformFrame,
          changedPixelRatio: capture.changedPixelRatio,
          captureFile: path.basename(capture.storedPath),
        },
      };
    },
  });

  const sendQemuDisplayInput = defineTool({
    name: "send_qemu_display_input",
    label: "Send QEMU input",
    description:
      "Send optional input to the active QEMU display session. Use serial mode for process stdin or key mode for one QEMU sendkey sequence.",
    parameters: Type.Object({
      mode: Type.Union([Type.Literal("serial"), Type.Literal("key")]),
      input: Type.String({ minLength: 1, maxLength: 4096 }),
    }),
    executionMode: "sequential" as const,
    async execute(_toolCallId, params) {
      if (params.mode === "key") {
        await sendGraphicalQemuKeys(displaySessionId, params.input);
      } else {
        sendGraphicalQemuInput(displaySessionId, params.input);
      }
      return {
        content: [{ type: "text" as const, text: `Sent ${params.mode} input to the QEMU display session.` }],
        details: { mode: params.mode },
      };
    },
  });

  const stopQemuDisplay = defineTool({
    name: "stop_qemu_display",
    label: "Stop QEMU display",
    description: "Stop and clean up the optional QEMU display session.",
    parameters: Type.Object({}),
    executionMode: "sequential" as const,
    async execute() {
      const state = stopGraphicalQemuSession(displaySessionId);
      return {
        content: [{ type: "text" as const, text: state ? "QEMU display session stop requested." : "No QEMU display session was active." }],
        details: { status: state?.status ?? "idle" },
      };
    },
  });

  return [
    defineTool(read),
    defineTool(bash),
    defineTool(edit),
    defineTool(write),
    startQemuDisplay,
    captureQemuDisplay,
    sendQemuDisplayInput,
    stopQemuDisplay,
  ];
}

/**
 * 功能：处理`courseworks` `tool` `info`。
 * 输入：无显式输入参数。
 * 输出：返回 readonly AgentToolInfo[]，供调用方继续处理。
 * 调用关系：由 `apps/server/src/modules/coding-agent/adapters/pi/pi-coding-agent-runtime.ts:listTools()` 调用。
 */
export function courseworksToolInfo(): readonly AgentToolInfo[] {
  return [
    { name: "read", description: "Read a workspace file with bounded output." },
    { name: "bash", description: "Run build and test commands in the isolated Courseworks container." },
    { name: "edit", description: "Replace text in an existing workspace file." },
    { name: "write", description: "Create or overwrite a workspace file." },
    { name: "start_qemu_display", description: "Optionally start an Agent-chosen QEMU command for graphical inspection." },
    { name: "capture_qemu_display", description: "Capture QEMU framebuffer metrics and a text preview." },
    { name: "send_qemu_display_input", description: "Send serial or keyboard input to the optional QEMU display session." },
    { name: "stop_qemu_display", description: "Stop the optional QEMU display session." },
  ];
}

export function courseworksReviewToolInfo(): readonly AgentToolInfo[] {
  return [
    { name: "ls", description: "List files in the teacher audit directory and approved student workspaces." },
    { name: "grep", description: "Search text in one approved student workspace or audit file." },
    { name: "read", description: "Read an audit mapping or student workspace file without modifying it." },
  ];
}
