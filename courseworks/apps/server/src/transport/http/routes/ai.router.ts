/**
 * 文件作用：把 HTTP 请求适配为后端应用层调用，并统一返回协议响应。
 * 模块位置：`apps/server/src/transport/http/routes/ai.router.ts`，属于后端 HTTP 协议适配层。
 * 重要函数：`formatConnectionTestError()` 负责格式化`connection` `test` 错误信息。
 */
import { Router, type Response } from "express";
import { z } from "zod";

import {
  AiProviderProfileError,
  clearClassAiProviderAssignment,
  createAiProviderProfile,
  deleteAiProviderProfile,
  discoverAiProviderModels,
  getAiModelProfile,
  getAiSettings,
  getClassAiProviderAssignment,
  listAiProviderProfiles,
  resetAiConversationContext,
  runDirectAiChat,
  runHomeworkTutorChat,
  selectClassAiProviderAssignment,
  streamHomeworkTutorChat,
  streamStudyTutorChat,
  selectAiProviderProfile,
  setClassAiProviderAssignment,
  testAiProviderProfile,
  testAiSettings,
  updateAiProviderProfile,
  updateAiSettings,
} from "../../../application/ai-settings/ai-settings-application.service.js";
import { normalizeClassAiDailyTokenLimit } from "../../../modules/ai-settings/index.js";
import {
  requireAuth,
  requireHomeworkTutorAuth,
  requireRoles,
} from "../middleware/auth.js";

const router = Router();
const protectedRoute = [requireAuth, requireRoles("teacher", "ta", "student")] as const;
const settingsSchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  reasoningEffort: z.enum([
    "default",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]).optional(),
});
const chatSchema = z.object({
  prompt: z.string().min(1),
  openFiles: z.array(z.string()).default([]),
});
const homeworkTutorSchema = z.object({
  questionContext: z.string().trim().min(1).max(30_000),
  reviewContext: z.string().trim().min(1).max(30_000).optional(),
  prompt: z.string().trim().min(1).max(4_000),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(4_000),
  })).max(12).default([]),
});
const studyTutorSchema = z.object({
  materialContext: z.string().trim().min(1).max(30_000),
  prompt: z.string().trim().min(1).max(4_000),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(4_000),
  })).max(12).default([]),
});
const modelDiscoverySchema = z.object({
  baseUrl: z.string().min(1),
  apiKey: z.string().optional(),
  profileId: z.string().min(1).optional(),
});
const providerProfileSchema = z.object({
  name: z.string().trim().min(1).max(128),
  baseUrl: z.string().trim().min(1),
  apiKey: z.string().optional(),
  model: z.string().trim().min(1),
  level: z.enum(["high", "medium", "low"]),
});
const classProviderSchema = z.object({
  profileId: z.string().trim().min(1),
  enforced: z.boolean(),
  dailyTokenLimit: z.number().int().min(0).max(100_000_000).nullable()
    .transform(normalizeClassAiDailyTokenLimit),
});

function sendProfileError(response: Response, error: unknown) {
  if (error instanceof z.ZodError) {
    response.status(400).json({ message: error.issues[0]?.message ?? "Profile 数据无效。" });
    return true;
  }
  if (error instanceof AiProviderProfileError) {
    response.status(error.status).json({ message: error.message });
    return true;
  }
  return false;
}

function profileIdFrom(request: { params: { profileId?: string | string[] } }) {
  const value = request.params.profileId;
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

/**
 * 功能：格式化`connection` `test` 错误信息。
 * 输入：`error`（unknown）提供错误信息。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/ai.router.ts 顶层流程` 调用；内部调用 `toLowerCase()`、`includes()`。
 */
function formatConnectionTestError(error: unknown) {
  if (!(error instanceof Error)) return "Connection test failed.";
  const message = error.message.toLowerCase();
  return message.includes("timeout") || message.includes("timed out")
    ? "Connection test timed out after 20 seconds."
    : error.message;
}

/**
 * 功能：处理 GET /settings 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/settings", ...protectedRoute, async (request, response, next) => {
  try {
    response.json({ settings: await getAiSettings(request.auth!.userId) });
  } catch (error) {
    next(error);
  }
});

router.get("/profiles", ...protectedRoute, async (request, response, next) => {
  try {
    response.json({ profiles: await listAiProviderProfiles(request.auth!.userId) });
  } catch (error) {
    next(error);
  }
});

router.get("/class-provider", ...protectedRoute, async (request, response, next) => {
  try {
    response.json(await getClassAiProviderAssignment(request.auth!.userId));
  } catch (error) {
    if (!sendProfileError(response, error)) next(error);
  }
});

router.post("/class-provider/select", requireAuth, requireRoles("student"), async (request, response, next) => {
  try {
    response.json(await selectClassAiProviderAssignment(request.auth!.userId));
  } catch (error) {
    if (!sendProfileError(response, error)) next(error);
  }
});

router.put(
  "/class-provider",
  requireAuth,
  requireRoles("teacher"),
  async (request, response, next) => {
    try {
      response.json(await setClassAiProviderAssignment(
        request.auth!.userId,
        classProviderSchema.parse(request.body),
      ));
    } catch (error) {
      if (!sendProfileError(response, error)) next(error);
    }
  },
);

router.delete(
  "/class-provider",
  requireAuth,
  requireRoles("teacher"),
  async (request, response, next) => {
    try {
      response.json(await clearClassAiProviderAssignment(request.auth!.userId));
    } catch (error) {
      if (!sendProfileError(response, error)) next(error);
    }
  },
);

router.post("/profiles", ...protectedRoute, async (request, response, next) => {
  try {
    const profile = await createAiProviderProfile(
      request.auth!.userId,
      providerProfileSchema.parse(request.body),
    );
    response.status(201).json({ profile });
  } catch (error) {
    if (!sendProfileError(response, error)) next(error);
  }
});

router.put("/profiles/:profileId", ...protectedRoute, async (request, response, next) => {
  try {
    const profile = await updateAiProviderProfile(
      request.auth!.userId,
      profileIdFrom(request),
      providerProfileSchema.parse(request.body),
    );
    response.json({ profile });
  } catch (error) {
    if (!sendProfileError(response, error)) next(error);
  }
});

router.delete("/profiles/:profileId", ...protectedRoute, async (request, response, next) => {
  try {
    response.json(await deleteAiProviderProfile(request.auth!.userId, profileIdFrom(request)));
  } catch (error) {
    if (!sendProfileError(response, error)) next(error);
  }
});

router.post("/profiles/:profileId/select", ...protectedRoute, async (request, response, next) => {
  try {
    response.json({
      profile: await selectAiProviderProfile(request.auth!.userId, profileIdFrom(request)),
    });
  } catch (error) {
    if (!sendProfileError(response, error)) next(error);
  }
});

router.post("/profiles/test", ...protectedRoute, async (request, response) => {
  const parsed = providerProfileSchema.partial().extend({ profileId: z.string().min(1).optional() })
    .safeParse(request.body ?? {});
  if (!parsed.success) {
    response.status(400).json({ message: parsed.error.issues[0]?.message ?? "Profile 数据无效。" });
    return;
  }
  try {
    response.json(await testAiProviderProfile(request.auth!.userId, parsed.data));
  } catch (error) {
    response.status(error instanceof AiProviderProfileError ? error.status : 400).json({
      message: formatConnectionTestError(error),
    });
  }
});

/**
 * 功能：处理 GET /model-profile 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.get("/model-profile", ...protectedRoute, async (request, response, next) => {
  try {
    const model = typeof request.query.model === "string" ? request.query.model : "";
    const baseUrl = typeof request.query.baseUrl === "string" ? request.query.baseUrl : undefined;
    response.json({ profile: await getAiModelProfile(model, baseUrl) });
  } catch (error) {
    next(error);
  }
});

/**
 * 功能：处理 POST /models/discover 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/models/discover", ...protectedRoute, async (request, response) => {
  const parsed = modelDiscoverySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    response.status(400).json({
      message: parsed.error.issues[0]?.message ?? "Invalid model discovery payload.",
    });
    return;
  }
  try {
    response.json(await discoverAiProviderModels(request.auth!.userId, parsed.data));
  } catch (error) {
    response.status(400).json({
      message: error instanceof Error ? error.message : "Unable to load provider models.",
    });
  }
});

/**
 * 功能：处理 PUT /settings 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.put("/settings", ...protectedRoute, async (request, response, next) => {
  try {
    const parsed = settingsSchema.parse(request.body);
    response.json({
      settings: await updateAiSettings(request.auth!.userId, parsed),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: error.issues[0]?.message ?? "Invalid settings." });
      return;
    }
    if (error instanceof Error && error.message === "请输入 API Key。") {
      response.status(400).json({ message: error.message });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 POST /context/reset 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/context/reset", ...protectedRoute, async (request, response, next) => {
  try {
    response.json({ message: await resetAiConversationContext(request.auth!.userId) });
  } catch (error) {
    if (error instanceof Error && error.message === "工作区尚未就绪。") {
      response.status(400).json({ message: error.message });
      return;
    }
    if (error instanceof Error && error.message.startsWith("请等待当前工作区任务")) {
      response.status(409).json({ message: error.message });
      return;
    }
    next(error);
  }
});

/**
 * 功能：处理 POST /chat 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/chat", ...protectedRoute, async (request, response, next) => {
  try {
    const parsed = chatSchema.parse(request.body);
    response.json({
      answer: await runDirectAiChat(
        request.auth!.userId,
        parsed.prompt,
        parsed.openFiles,
      ),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      response.status(400).json({ message: "聊天请求无效。" });
      return;
    }
    if (
      error instanceof Error
      && (error.message === "工作区尚未就绪。"
        || error.message.startsWith("请先在服务门户中配置 AI Provider"))
    ) {
      response.status(400).json({ message: error.message });
      return;
    }
    next(error);
  }
});

router.post(
  "/homework-tutor",
  requireHomeworkTutorAuth,
  async (request, response, next) => {
    try {
      const parsed = homeworkTutorSchema.parse(request.body);
      response.json({
        answer: await runHomeworkTutorChat(
          request.auth!.userId,
          parsed.questionContext,
          parsed.prompt,
          parsed.history,
          request.auth!.homeworkTutorMode!,
          request.auth!.homeworkTutorMode === "review"
            ? parsed.reviewContext
            : undefined,
        ),
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        response.status(400).json({ message: "AI 辅导请求无效。" });
        return;
      }
      if (
        error instanceof Error
        && error.message.startsWith("请先在服务门户中配置 AI Provider")
      ) {
        response.status(400).json({ message: error.message });
        return;
      }
      next(error);
    }
  },
);

router.post(
  "/homework-tutor/stream",
  requireHomeworkTutorAuth,
  async (request, response, next) => {
    try {
      const parsed = homeworkTutorSchema.parse(request.body);
      const stream = await streamHomeworkTutorChat(
        request.auth!.userId,
        parsed.questionContext,
        parsed.prompt,
        parsed.history,
        request.auth!.homeworkTutorMode!,
        request.auth!.homeworkTutorMode === "review"
          ? parsed.reviewContext
          : undefined,
      );
      response.status(200).set({
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();
      for await (const delta of stream) {
        response.write(`${JSON.stringify({ delta })}\n`);
      }
      response.end(`${JSON.stringify({ done: true })}\n`);
    } catch (error) {
      if (response.headersSent) {
        const message = error instanceof Error ? error.message : "AI 输出中断，请重试。";
        response.end(`${JSON.stringify({ error: message })}\n`);
        return;
      }
      if (error instanceof z.ZodError) {
        response.status(400).json({ message: "AI 辅导请求无效。" });
        return;
      }
      if (
        error instanceof Error
        && error.message.startsWith("请先在服务门户中配置 AI Provider")
      ) {
        response.status(400).json({ message: error.message });
        return;
      }
      next(error);
    }
  },
);

router.post(
  "/study-tutor/stream",
  ...protectedRoute,
  async (request, response, next) => {
    try {
      const parsed = studyTutorSchema.parse(request.body);
      const stream = await streamStudyTutorChat(
        request.auth!.userId,
        parsed.materialContext,
        parsed.prompt,
        parsed.history,
      );
      response.status(200).set({
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      });
      response.flushHeaders();
      for await (const delta of stream) {
        response.write(`${JSON.stringify({ delta })}\n`);
      }
      response.end(`${JSON.stringify({ done: true })}\n`);
    } catch (error) {
      if (response.headersSent) {
        const message = error instanceof Error ? error.message : "AI 输出中断，请重试。";
        response.end(`${JSON.stringify({ error: message })}\n`);
        return;
      }
      if (error instanceof z.ZodError) {
        response.status(400).json({ message: "学习材料 AI 请求无效。" });
        return;
      }
      if (error instanceof Error && error.message.startsWith("请先在服务门户中配置 AI Provider")) {
        response.status(400).json({ message: error.message });
        return;
      }
      next(error);
    }
  },
);

/**
 * 功能：处理 POST /test 请求并把结果转换为 HTTP 响应。
 * 输入：Express request 提供认证信息、路径、查询或请求体；response 用于返回状态码和响应数据。
 * 输出：无业务返回值，通过 Express response 结束请求；异步错误交由当前处理器或错误中间件转换。
 * 调用关系：由 Express 在路由命中时调用；内部委托 application service 或模块公共 API。
 */
router.post("/test", ...protectedRoute, async (request, response) => {
  const parsed = settingsSchema.partial().safeParse(request.body ?? {});
  if (!parsed.success) {
    response.status(400).json({
      message: parsed.error.issues[0]?.message ?? "Invalid test payload.",
    });
    return;
  }
  try {
    response.json(await testAiSettings(request.auth!.userId, parsed.data));
  } catch (error) {
    response.status(400).json({ message: formatConnectionTestError(error) });
  }
});

export { router as aiRouter };
