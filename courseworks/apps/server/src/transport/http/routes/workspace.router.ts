/**
 * 文件作用：把 HTTP 请求适配为后端应用层调用，并统一返回协议响应。
 * 模块位置：`apps/server/src/transport/http/routes/workspace.router.ts`，属于后端 HTTP 协议适配层。
 * 重要函数：`errorMessage()` 负责处理错误信息 消息；`isWorkspacePathError()` 负责判断是否为工作区 路径 错误信息；`pathErrorMessage()` 负责处理路径 错误信息 消息；`parseMultipartFormData()` 负责解析`multipart` `form` `data`。
 */
import fs from "node:fs/promises";
import path from "node:path";

import { Router, type Request as ExpressRequest } from "express";
import { z } from "zod";

import {
  closeWorkspaceLabShell,
  createWorkspaceDirectory,
  createWorkspaceFile,
  createWorkspaceLabShell,
  deleteWorkspaceDirectory,
  deleteWorkspaceFile,
  exportStudentWorkspace,
  getWorkspaceBuildTarget,
  getWorkspaceLab,
  getWorkspaceLabVncStatus,
  getWorkspaceStatus,
  getWorkspaceTree,
  importStudentWorkspace,
  initializeStudentWorkspace,
  listWorkspaceUploads,
  readWorkspaceFile,
  removeWorkspaceUpload,
  resetWorkspaceLab,
  resizeWorkspaceLabShell,
  saveWorkspaceFile,
  sendWorkspaceLabInput,
  sendWorkspaceLabShellInput,
  stageWorkspaceUploads,
  startWorkspaceLab,
  stopWorkspaceLab,
  uploadWorkspaceFile,
} from "../../../application/workspace/workspace-application.service.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = Router();
const protectedRoute = [requireAuth, requireRoles("teacher", "ta", "student")] as const;

const filePathSchema = z.object({ path: z.string().min(1) });
const createFileSchema = z.object({
  path: z.string().min(1),
  content: z.string().default(""),
});
const saveFileSchema = z.object({ path: z.string().min(1), content: z.string() });
const uploadFileSchema = z.object({
  path: z.string().min(1),
  contentBase64: z.string(),
});
const stagedUploadSchema = z.object({
  files: z.array(z.object({
    name: z.string().min(1).max(255),
    mimeType: z.string().max(255).optional(),
    contentBase64: z.string().min(1),
  })).min(1).max(12),
});
const directorySchema = z.object({ path: z.string().min(1) });
const qemuInputSchema = z.object({ input: z.string().min(1).max(4000) });
const terminalSizeSchema = z.object({
  columns: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
});
const vncStatusSchema = z.object({ sessionId: z.string().min(1) });
const workspaceImportFieldsSchema = z.object({
  mode: z.enum(["archive-only", "extract"]).default("extract"),
  targetPath: z.string().optional().default(""),
  overwritePolicy: z.enum(["fail", "merge", "overwrite"]).default("fail"),
});

/**
 * 功能：处理错误信息 消息。
 * 输入：`error`（unknown）提供错误信息。 `fallback`（string）提供fallback。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/agent.router.ts 顶层流程`、`apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用。
 */
function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

/**
 * 功能：判断是否为工作区 路径 错误信息。
 * 输入：`error`（unknown）提供错误信息。
 * 输出：返回判断或校验结果；校验失败时可能抛出异常。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `startsWith()`。
 */
function isWorkspacePathError(error: unknown) {
  return error instanceof Error && (
    error.message === "Invalid path."
    || error.message === "Invalid workspace path."
    || error.message === "Blocked workspace path."
    || error.message === "Workspace root cannot be modified through this endpoint."
    || error.message.startsWith("Patch target crosses a symbolic link:")
  );
}

/**
 * 功能：处理路径 错误信息 消息。
 * 输入：`error`（unknown）提供错误信息。 `fallback`提供fallback。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用。
 */
function pathErrorMessage(error: unknown, fallback = "Invalid file path.") {
  if (
    error instanceof Error
    && error.message === "Workspace root cannot be modified through this endpoint."
  ) {
    return error.message;
  }
  return fallback;
}

/**
 * 功能：解析`multipart` `form` `data`。
 * 输入：`request`（ExpressRequest）提供请求。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/workspace.router.ts 顶层流程` 调用；内部调用 `formData()`。
 */
async function parseMultipartFormData(request: ExpressRequest) {
  const multipartRequest = new Request("http://localhost/api/workspace/import", {
    method: request.method,
    headers: request.headers as HeadersInit,
    body: request as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  return multipartRequest.formData();
}

/**
 * 功能：处理 GET /status 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/status", ...protectedRoute, async (request, response, next) => {
  try {
    response.json({ workspace: await getWorkspaceStatus(request.auth!.userId) });
  } catch (error) {
    next(error);
  }
});

/**
 * 功能：处理 POST /initialize 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/initialize", ...protectedRoute, async (request, response, next) => {
  try {
    const result = await initializeStudentWorkspace(request.auth!.userId);
    response.status(result.initialized ? 201 : 200).json({ workspace: result.workspace });
  } catch (error) {
    next(error);
  }
});

/**
 * 功能：处理 GET /tree 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/tree", ...protectedRoute, async (request, response, next) => {
  try {
    response.json({ tree: await getWorkspaceTree(request.auth!.userId) });
  } catch (error) {
    if (error instanceof Error && error.message === "工作区尚未就绪。") {
      response.status(400).json({ message: error.message });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 POST /import 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/import", ...protectedRoute, async (request, response) => {
  try {
    const formData = await parseMultipartFormData(request);
    const parsedFields = workspaceImportFieldsSchema.parse({
      mode: formData.get("mode"),
      targetPath: formData.get("targetPath"),
      overwritePolicy: formData.get("overwritePolicy"),
    });
    const file = formData.get("file");
    if (!(file instanceof File)) {
      response.status(400).json({ message: "请选择压缩包文件。" });
      return;
    }
    const summary = await importStudentWorkspace(request.auth!.userId, {
      originalName: file.name,
      archiveBuffer: Buffer.from(await file.arrayBuffer()),
      ...parsedFields,
    });
    response.status(201).json({ summary });
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({
        message: error.issues[0]?.message ?? "Invalid workspace import request.",
      });
      return;
    }
    console.warn("[workspace-import] failed", errorMessage(error, "Workspace import failed."));
    response.status(400).json({ message: errorMessage(error, "Workspace import failed.") });
  }
});

/**
 * 功能：处理 GET /export.zip 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/export.zip", ...protectedRoute, async (request, response) => {
  try {
    const result = await exportStudentWorkspace(request.auth!.userId);
    response.setHeader("Content-Type", "application/zip");
    response.setHeader("Content-Disposition", `attachment; filename="${result.downloadName}"`);
    response.sendFile(result.archivePath, async (error) => {
      await fs.rm(result.archivePath, { force: true }).catch(() => undefined);
      await fs.rm(path.dirname(result.archivePath), { recursive: true, force: true }).catch(() => undefined);
      if (error && !response.headersSent) {
        response.status(500).json({ message: "工作区导出失败。" });
      }
    });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Workspace export failed.") });
  }
});

/**
 * 功能：处理 GET /file 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/file", ...protectedRoute, async (request, response, next) => {
  try {
    const parsed = filePathSchema.parse(request.query);
    response.json(await readWorkspaceFile(request.auth!.userId, parsed.path));
  } catch (error) {
    if (error instanceof z.ZodError || isWorkspacePathError(error)) {
      response.status(400).json({ message: "文件路径无效。" });
      return;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      response.status(404).json({ message: "文件不存在。" });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 POST /file 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/file", ...protectedRoute, async (request, response, next) => {
  try {
    const parsed = createFileSchema.parse(request.body);
    response.status(201).json(
      await createWorkspaceFile(request.auth!.userId, parsed.path, parsed.content),
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "创建文件的请求无效。" });
      return;
    }
    if (isWorkspacePathError(error)) {
      response.status(400).json({ message: pathErrorMessage(error) });
      return;
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      response.status(409).json({ message: "文件已存在。" });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 PUT /file 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.put("/file", ...protectedRoute, async (request, response, next) => {
  try {
    const parsed = saveFileSchema.parse(request.body);
    response.json(await saveWorkspaceFile(request.auth!.userId, parsed.path, parsed.content));
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "保存文件的请求无效。" });
      return;
    }
    if (isWorkspacePathError(error)) {
      response.status(400).json({ message: pathErrorMessage(error) });
      return;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      response.status(404).json({ message: "文件不存在。" });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 POST /upload 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/upload", ...protectedRoute, async (request, response, next) => {
  try {
    const parsed = uploadFileSchema.parse(request.body);
    response.status(201).json(
      await uploadWorkspaceFile(
        request.auth!.userId,
        parsed.path,
        parsed.contentBase64,
      ),
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "上传文件的请求无效。" });
      return;
    }
    if (isWorkspacePathError(error)) {
      response.status(400).json({ message: pathErrorMessage(error, "Invalid upload path.") });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 GET /uploads 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/uploads", ...protectedRoute, async (request, response) => {
  try {
    response.json({ uploads: await listWorkspaceUploads(request.auth!.userId) });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Unable to load staged uploads.") });
  }
});

/**
 * 功能：处理 POST /uploads 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/uploads", ...protectedRoute, async (request, response) => {
  try {
    const parsed = stagedUploadSchema.parse(request.body);
    response.status(201).json({
      uploads: await stageWorkspaceUploads(request.auth!.userId, parsed.files),
    });
  } catch (error) {
    response.status(400).json({
      message: error instanceof z.ZodError
        ? "Invalid staged upload request."
        : errorMessage(error, "Unable to stage uploads."),
    });
  }
});

/**
 * 功能：处理 DELETE /uploads/:id 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.delete("/uploads/:id", ...protectedRoute, async (request, response) => {
  try {
    const removed = await removeWorkspaceUpload(
      request.auth!.userId,
      String(request.params.id),
    );
    if (!removed) {
      response.status(404).json({ message: "暂存附件不存在。" });
      return;
    }
    response.json({ ok: true });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Unable to remove staged upload.") });
  }
});

/**
 * 功能：处理 DELETE /file 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.delete("/file", ...protectedRoute, async (request, response, next) => {
  try {
    const parsed = filePathSchema.parse(request.query);
    response.json(await deleteWorkspaceFile(request.auth!.userId, parsed.path));
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "删除文件的请求无效。" });
      return;
    }
    if (isWorkspacePathError(error)) {
      response.status(400).json({ message: pathErrorMessage(error) });
      return;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      response.status(404).json({ message: "文件不存在。" });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 POST /directory 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/directory", ...protectedRoute, async (request, response, next) => {
  try {
    const parsed = directorySchema.parse(request.body);
    response.status(201).json(
      await createWorkspaceDirectory(request.auth!.userId, parsed.path),
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "创建目录的请求无效。" });
      return;
    }
    if (isWorkspacePathError(error)) {
      response.status(400).json({ message: pathErrorMessage(error, "Invalid directory path.") });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 DELETE /directory 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.delete("/directory", ...protectedRoute, async (request, response, next) => {
  try {
    const parsed = directorySchema.parse(request.query);
    response.json(await deleteWorkspaceDirectory(request.auth!.userId, parsed.path));
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "删除目录的请求无效。" });
      return;
    }
    if (isWorkspacePathError(error)) {
      response.status(400).json({ message: pathErrorMessage(error, "Invalid directory path.") });
      return;
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      response.status(404).json({ message: "目录不存在。" });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 GET /build-target 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/build-target", ...protectedRoute, (_request, response) => {
  response.json(getWorkspaceBuildTarget());
});

/**
 * 功能：处理 GET /lab 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/lab", ...protectedRoute, async (request, response) => {
  try {
    response.json(await getWorkspaceLab(request.auth!.userId));
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Unable to load OS Lab.") });
  }
});

router.get("/lab/vnc-status", ...protectedRoute, async (request, response) => {
  try {
    const { sessionId } = vncStatusSchema.parse(request.query);
    response.json({ status: await getWorkspaceLabVncStatus(request.auth!.userId, sessionId) });
  } catch (error) {
    response.status(error instanceof z.ZodError ? 400 : 404).json({
      message: errorMessage(error, "Unable to inspect the QEMU VNC connection."),
    });
  }
});

/** 进入普通 OS Lab 时丢弃旧运行态，并返回一个全新的 Bash 会话。 */
router.post("/lab/reset", ...protectedRoute, async (request, response) => {
  try {
    response.json(await resetWorkspaceLab(request.auth!.userId));
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Unable to reset OS Lab.") });
  }
});

/**
 * 功能：处理 POST /lab/shells 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/lab/shells", ...protectedRoute, async (request, response) => {
  try {
    response.status(201).json({
      session: await createWorkspaceLabShell(request.auth!.userId),
    });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Unable to create workspace shell.") });
  }
});

/**
 * 功能：处理 POST /lab/shells/:sessionId/input 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/lab/shells/:sessionId/input", ...protectedRoute, async (request, response) => {
  try {
    const parsed = qemuInputSchema.parse(request.body);
    response.json({
      session: await sendWorkspaceLabShellInput(
        request.auth!.userId,
        String(request.params.sessionId),
        parsed.input,
      ),
    });
  } catch (error) {
    const status = error instanceof Error && error.message === "Workspace shell not found." ? 404 : 400;
    response.status(status).json({ message: errorMessage(error, "Unable to send shell input.") });
  }
});

/**
 * 功能：处理 POST /lab/shells/:sessionId/resize 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/lab/shells/:sessionId/resize", ...protectedRoute, async (request, response) => {
  try {
    const parsed = terminalSizeSchema.parse(request.body);
    response.json({
      session: await resizeWorkspaceLabShell(
        request.auth!.userId,
        String(request.params.sessionId),
        parsed.columns,
        parsed.rows,
      ),
    });
  } catch (error) {
    const status = error instanceof Error && error.message === "Workspace shell not found." ? 404 : 400;
    response.status(status).json({ message: errorMessage(error, "Unable to resize workspace shell.") });
  }
});

/**
 * 功能：处理 DELETE /lab/shells/:sessionId 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.delete("/lab/shells/:sessionId", ...protectedRoute, async (request, response) => {
  try {
    response.json({
      session: await closeWorkspaceLabShell(
        request.auth!.userId,
        String(request.params.sessionId),
      ),
    });
  } catch (error) {
    const status = error instanceof Error && error.message === "Workspace shell not found." ? 404 : 400;
    response.status(status).json({ message: errorMessage(error, "Unable to close workspace shell.") });
  }
});

/**
 * 功能：处理 POST /lab/start 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/lab/start", ...protectedRoute, async (request, response) => {
  try {
    response.json({ session: await startWorkspaceLab(request.auth!.userId) });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Unable to start QEMU.") });
  }
});

/**
 * 功能：处理 POST /lab/input 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/lab/input", ...protectedRoute, async (request, response) => {
  try {
    const parsed = qemuInputSchema.parse(request.body);
    response.json({
      session: await sendWorkspaceLabInput(request.auth!.userId, parsed.input),
    });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Unable to send QEMU input.") });
  }
});

/**
 * 功能：处理 POST /lab/stop 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/lab/stop", ...protectedRoute, async (request, response) => {
  try {
    response.json({ session: await stopWorkspaceLab(request.auth!.userId) });
  } catch (error) {
    response.status(400).json({ message: errorMessage(error, "Unable to stop QEMU.") });
  }
});

export { router as workspaceRouter };
