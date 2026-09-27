/**
 * 文件作用：把 HTTP 请求适配为后端应用层调用，并统一返回协议响应。
 * 模块位置：`apps/server/src/transport/http/agent.router.ts`，属于后端 HTTP 协议适配层。
 * 重要函数：`errorMessage()` 负责处理错误信息 消息。
 */
import { Router } from "express";
import { z } from "zod";

import {
  analyzeAgentBuild,
  analyzeAgentQemuRun,
  applyAgentPatchPlan,
  buildAgentRun,
  compactAgentChat,
  getAgentArtifactDownload,
  getAgentAttachmentPreview,
  getAgentChatSnapshot,
  getAgentChatContextUsage,
  getAgentCourseTaskSnapshot,
  getAgentPatchPlan,
  getAgentQemuSession,
  getAgentRunDetail,
  getAgentRunTrace,
  inspectAgentChatContext,
  listAgentCheckpoints,
  listAgentRuns,
  listAgentTools,
  restoreAgentCheckpoint,
  sendAgentQemuInput,
  smokeTestAgentRun,
  startAgentQemuSession,
  startNewAgentChat,
  stopAgentQemuSession,
  stopAgentRun,
  submitAgentPrompt,
} from "../../application/agent/agent-application.service.js";
import { logSystem } from "../../infrastructure/logging/logger.js";
import { requireAuth, requireRoles } from "./middleware/auth.js";

const router = Router();
const protectedRoute = [requireAuth, requireRoles("teacher", "ta", "student")] as const;

const runSchema = z.object({
  prompt: z.string().min(1),
  mode: z.enum(["work", "review"]).optional(),
  runMode: z.enum(["continue_subtask", "new_subtask", "reset_context_then_run"]).optional(),
  openFiles: z.array(z.string()).max(12).optional(),
  attachmentIds: z.array(z.string().min(1)).max(12).optional(),
  selection: z.object({
    filePath: z.string(),
    text: z.string(),
    startLine: z.number(),
    endLine: z.number(),
  }).optional(),
});
const checkpointSchema = z.object({ checkpointId: z.string().min(1) });
const qemuInputSchema = z.object({ input: z.string().min(1).max(4000) });
const newSessionSchema = z.object({
  reason: z.literal("user_slash_new"),
  confirmed: z.literal(true),
  mode: z.enum(["work", "review"]).optional(),
});
const compactSchema = z.object({ mode: z.enum(["work", "review"]).optional() });

function requestAgentMode(value: unknown) {
  return value === "review" ? "review" as const : "work" as const;
}

/**
 * 功能：处理错误信息 消息。
 * 输入：`error`（unknown）提供错误信息。 `fallback`（string）提供fallback。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程`、`apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用。
 */
function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function errorStatus(error: unknown, fallback: number) {
  return error instanceof Error
    && "status" in error
    && typeof error.status === "number"
    && error.status >= 400
    && error.status < 500
    ? error.status
    : fallback;
}

/**
 * 功能：处理 POST /runs 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/runs", ...protectedRoute, async (request, response) => {
  try {
    const parsed = runSchema.parse(request.body);
    const result = await submitAgentPrompt({
      userId: request.auth!.userId,
      email: request.auth!.email,
      prompt: parsed.prompt,
      mode: parsed.mode,
      openFiles: parsed.openFiles,
      attachmentIds: parsed.attachmentIds,
      selection: parsed.selection,
    });
    response.status(result.type === "run" ? 201 : 200).json(
      result.type === "run" ? { run: result.run } : { command: result.command },
    );
  } catch (error) {
    response.status(errorStatus(error, 400)).json({
      message: error instanceof z.ZodError
        ? "Invalid Agent Run request."
        : errorMessage(error, "Agent Run failed."),
    });
  }
});

/**
 * 功能：处理 GET /course-task 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/course-task", ...protectedRoute, async (request, response) => {
  try {
    response.json({ courseTask: await getAgentCourseTaskSnapshot(request.auth!.userId) });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Unable to load course task.") });
  }
});

/**
 * 功能：处理 GET /chat-sessions 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/chat-sessions", ...protectedRoute, async (request, response) => {
  try {
    response.json({ chat: await getAgentChatSnapshot(
      request.auth!.userId,
      requestAgentMode(request.query.mode),
    ) });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Unable to load chat session.") });
  }
});

/**
 * 功能：处理 GET /chat-sessions/context-usage 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/chat-sessions/context-usage", ...protectedRoute, async (request, response) => {
  try {
    response.json({
      contextUsage: await getAgentChatContextUsage(
        request.auth!.userId,
        requestAgentMode(request.query.mode),
      ),
    });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Unable to read context usage.") });
  }
});

/**
 * 功能：处理 POST /chat-sessions/new 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/chat-sessions/new", ...protectedRoute, async (request, response) => {
  try {
    const parsed = newSessionSchema.parse(request.body);
    response.json({
      chat: await startNewAgentChat(request.auth!.userId, request.auth!.email, parsed.mode),
    });
  } catch (error) {
    const message = error instanceof z.ZodError
      ? "Invalid /new request."
      : errorMessage(error, "Unable to start a new chat session.");
    logSystem(`/new failed: ${message}`);
    response.status(400).json({ message });
  }
});

/**
 * 功能：处理 POST /chat-sessions/compact 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/chat-sessions/compact", ...protectedRoute, async (request, response) => {
  try {
    const parsed = compactSchema.parse(request.body);
    response.json({
      compact: await compactAgentChat(request.auth!.userId, request.auth!.email, parsed.mode),
    });
  } catch (error) {
    response.status(errorStatus(error, 400)).json({ message: errorMessage(error, "Compaction failed.") });
  }
});

/**
 * 功能：处理 POST /chat-sessions/context 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/chat-sessions/context", ...protectedRoute, async (request, response) => {
  try {
    response.json({ context: await inspectAgentChatContext(
      request.auth!.userId,
      requestAgentMode(request.body?.mode),
    ) });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Unable to inspect context.") });
  }
});

/**
 * 功能：处理 GET /tools 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/tools", ...protectedRoute, (request, response) => {
  response.json({ tools: listAgentTools(requestAgentMode(request.query.mode)) });
});

/**
 * 功能：处理 GET /session-artifacts/:artifactId/download 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/session-artifacts/:artifactId/download", ...protectedRoute, async (request, response) => {
  try {
    const artifact = await getAgentArtifactDownload(
      request.auth!.userId,
      String(request.params.artifactId),
    );
    if (!artifact) {
      response.status(404).json({ message: "产物不存在。" });
      return;
    }
    response.setHeader("Content-Type", artifact.mimeType || "application/octet-stream");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${artifact.downloadName}"`,
    );
    response.sendFile(artifact.artifactPath);
  } catch (error) {
    response.status(400).json({
      message: errorMessage(error, "Unable to download session artifact."),
    });
  }
});

/** Serve an archived raster attachment inline; ownership is checked by workspace lookup. */
router.get("/session-attachments/:artifactId/preview", ...protectedRoute, async (request, response) => {
  try {
    const artifact = await getAgentAttachmentPreview(
      request.auth!.userId,
      String(request.params.artifactId),
    );
    if (!artifact) {
      response.status(404).json({ message: "图片附件不存在。" });
      return;
    }
    response.setHeader("Content-Type", artifact.mimeType);
    response.setHeader("Cache-Control", "private, max-age=3600");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.sendFile(artifact.artifactPath);
  } catch (error) {
    response.status(400).json({
      message: errorMessage(error, "Unable to preview image attachment."),
    });
  }
});

/**
 * 功能：处理 POST /runs/:id/stop 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/runs/:id/stop", ...protectedRoute, async (request, response) => {
  try {
    response.json({
      run: await stopAgentRun(String(request.params.id), request.auth!.userId),
    });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Unable to stop workspace task.") });
  }
});

/**
 * 功能：处理 GET /runs 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/runs", ...protectedRoute, async (request, response, next) => {
  try {
    response.json({ runs: await listAgentRuns(request.auth!.userId) });
  } catch (error) {
    next(error);
  }
});

/**
 * 功能：处理 GET /runs/:id 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/runs/:id", ...protectedRoute, async (request, response) => {
  try {
    response.json({
      run: await getAgentRunDetail(String(request.params.id), request.auth!.userId),
    });
  } catch (error) {
    response.status(404).json({ message: errorMessage(error, "Agent 运行记录不存在。") });
  }
});

/**
 * 功能：处理 GET /runs/:id/trace 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/runs/:id/trace", ...protectedRoute, async (request, response) => {
  try {
    response.json({
      trace: await getAgentRunTrace(String(request.params.id), request.auth!.userId),
    });
  } catch {
    response.status(404).json({ message: "运行过程记录不存在。" });
  }
});

/**
 * 功能：处理 GET /patch-plans/:id 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/patch-plans/:id", ...protectedRoute, async (request, response, next) => {
  try {
    const patchPlan = await getAgentPatchPlan(
      String(request.params.id),
      request.auth!.userId,
    );
    if (!patchPlan) {
      response.status(404).json({ message: "补丁方案不存在。" });
      return;
    }
    response.json({ patchPlan });
  } catch (error) {
    next(error);
  }
});

/**
 * 功能：处理 POST /patch-plans/:id/apply 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/patch-plans/:id/apply", ...protectedRoute, async (request, response) => {
  try {
    const result = await applyAgentPatchPlan(
      String(request.params.id),
      request.auth!.userId,
    );
    if (!result) {
      response.status(404).json({ message: "补丁方案不存在。" });
      return;
    }
    response.json(result);
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Patch apply failed.") });
  }
});

/**
 * 功能：处理 GET /checkpoints 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/checkpoints", ...protectedRoute, async (request, response, next) => {
  try {
    response.json({ checkpoints: await listAgentCheckpoints(request.auth!.userId) });
  } catch (error) {
    next(error);
  }
});

/**
 * 功能：处理 POST /checkpoints/restore 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/checkpoints/restore", ...protectedRoute, async (request, response) => {
  try {
    const parsed = checkpointSchema.parse(request.body);
    response.json({
      checkpoint: await restoreAgentCheckpoint(parsed.checkpointId, request.auth!.userId),
    });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Restore failed.") });
  }
});

/**
 * 功能：处理 POST /runs/:id/build 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/runs/:id/build", ...protectedRoute, async (request, response) => {
  try {
    response.json({
      buildRun: await buildAgentRun(String(request.params.id), request.auth!.userId),
    });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Build failed.") });
  }
});

/**
 * 功能：处理 GET /runs/:id/qemu-session 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/runs/:id/qemu-session", ...protectedRoute, async (request, response) => {
  try {
    response.json({
      session: await getAgentQemuSession(String(request.params.id), request.auth!.userId),
    });
  } catch {
    response.status(404).json({ message: "QEMU 会话不存在。" });
  }
});

/**
 * 功能：处理 POST /runs/:id/qemu-session/start 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/runs/:id/qemu-session/start", ...protectedRoute, async (request, response) => {
  try {
    response.json({
      session: await startAgentQemuSession(String(request.params.id), request.auth!.userId),
    });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Failed to start QEMU.") });
  }
});

/**
 * 功能：处理 POST /runs/:id/qemu-session/input 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/runs/:id/qemu-session/input", ...protectedRoute, async (request, response) => {
  try {
    const parsed = qemuInputSchema.parse(request.body);
    response.json({
      session: await sendAgentQemuInput(
        String(request.params.id),
        request.auth!.userId,
        parsed.input,
      ),
    });
  } catch (error) {
    response.status(400).json({
      message: error instanceof z.ZodError
        ? "Invalid QEMU input."
        : errorMessage(error, "Failed to send QEMU input."),
    });
  }
});

/**
 * 功能：处理 POST /runs/:id/qemu-session/stop 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/runs/:id/qemu-session/stop", ...protectedRoute, async (request, response) => {
  try {
    response.json({
      session: await stopAgentQemuSession(String(request.params.id), request.auth!.userId),
    });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Failed to stop QEMU.") });
  }
});

/**
 * 功能：处理 POST /runs/:id/qemu-smoke 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/runs/:id/qemu-smoke", ...protectedRoute, async (request, response) => {
  try {
    response.json({
      qemuSmokeRun: await smokeTestAgentRun(
        String(request.params.id),
        request.auth!.userId,
      ),
    });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "QEMU smoke failed.") });
  }
});

/**
 * 功能：处理 POST /build-runs/:id/analyze 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/build-runs/:id/analyze", ...protectedRoute, async (request, response) => {
  try {
    const buildRun = await analyzeAgentBuild(
      String(request.params.id),
      request.auth!.userId,
    );
    if (!buildRun) {
      response.status(404).json({ message: "构建记录或 AI 设置不存在。" });
      return;
    }
    response.json({ buildRun });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Analysis failed.") });
  }
});

/**
 * 功能：处理 POST /qemu-smoke-runs/:id/analyze 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/qemu-smoke-runs/:id/analyze", ...protectedRoute, async (request, response) => {
  try {
    const qemuSmokeRun = await analyzeAgentQemuRun(
      String(request.params.id),
      request.auth!.userId,
    );
    if (!qemuSmokeRun) {
      response.status(404).json({ message: "QEMU 运行记录或 AI 设置不存在。" });
      return;
    }
    response.json({ qemuSmokeRun });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Analysis failed.") });
  }
});

export { router as agentRouter };
