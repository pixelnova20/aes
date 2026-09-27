/**
 * 文件作用：编排后端“AI Provider 与模型设置”应用编排层用例及其跨模块调用。
 * 模块位置：`apps/server/src/application/ai-settings/ai-settings-application.service.ts`，属于后端“AI Provider 与模型设置”应用编排层。
 * 重要函数：`presentSettings()` 负责转换并展示设置；`getAiSettings()` 负责获取`ai` 设置；`getAiModelProfile()` 负责获取`ai` 模型 模型档案；`updateAiSettings()` 负责更新`ai` 设置；`resetAiConversationContext()` 负责重置`ai` `conversation` 上下文；`runDirectAiChat()` 负责执行`direct` `ai` 聊天；`testAiSettings()` 负责测试`ai` 设置；`discoverAiProviderModels()` 负责发现`ai` Provider 模型列表。
 */
import fs from "node:fs/promises";

import { AiProviderLevel, Prisma, WorkspaceStatus } from "@prisma/client";

import { config } from "../../config/index.js";
import { prisma } from "../../infrastructure/prisma/client.js";
import { ACTIVE_AGENT_RUN_STATUSES } from "../../modules/agent-runs/index.js";
import {
  buildHomeworkTutorSystemPrompt,
  buildHomeworkTutorUserPrompt,
  buildRuntimeAiIdentityPrompt,
  buildStudyTutorSystemPrompt,
  buildStudyTutorUserPrompt,
  beginClassAiChatQuota,
  findModelProfileByName,
  getClassAiTokenQuotaStatus,
  getAiProviderOwnerEmail,
  listAiProviderModels,
  maskApiKey,
  normalizeReasoningEffortForModel,
  normalizeProviderBaseUrl,
  resolveModelCapabilities,
  resolveContextWindowTokens,
  resolvePersonalSelectedAiProviderProfile,
  resolveSelectedAiProviderProfile,
  runOpenAiCompatibleChat,
  streamOpenAiCompatibleChat,
  withUserAiRequestSlot,
  withUserAiStreamSlot,
  testAiProvider,
  type ReasoningEffort,
  type HomeworkTutorTurn,
  type HomeworkTutorMode,
  type OpenAiCompatibleChatInput,
  type StudyTutorTurn,
  type ClassQuotaProvider,
} from "../../modules/ai-settings/index.js";
import {
  resetWorkspaceAgentRuntime,
} from "../../modules/execution/index.js";
import {
  assertNoSymlinkPath,
  ensureWorkspacePath,
} from "../../modules/workspaces/index.js";

export type AiSettingsInput = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  temperature?: number;
  contextWindowTokens?: number;
  reasoningEffort?: ReasoningEffort;
};

export type AiProviderProfileInput = {
  name: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  level: AiProviderLevel;
};

export class AiProviderProfileError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) {
    super(message);
    this.name = "AiProviderProfileError";
  }
}

function presentClassProviderAssignment(
  currentClass: {
    id: string;
    code: string;
    courseName: string | null;
    className: string | null;
  } | null,
  assignment: {
    id: string;
    enforced: boolean;
    dailyTokenLimit: number | null;
    profile: {
      id: string;
      name: string;
      baseUrl: string;
      model: string;
      level: AiProviderLevel;
    };
  } | null,
  quotaStatus: {
    usageDate: string;
    dailyTokenLimit: number;
    usedTokens: number;
    remainingTokens: number;
  } | null = null,
) {
  return {
    currentClass: currentClass ? {
      id: currentClass.id,
      invitationCode: currentClass.code,
      courseName: currentClass.courseName,
      className: currentClass.className,
    } : null,
    assignment: assignment ? {
      profileId: assignment.profile.id,
      profileName: assignment.profile.name,
      baseUrl: assignment.profile.baseUrl,
      model: assignment.profile.model,
      level: assignment.profile.level,
      enforced: assignment.enforced,
      dailyTokenLimit: assignment.dailyTokenLimit,
      quotaStatus,
    } : null,
  };
}

async function currentClassContext(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      role: true,
      inviteCodeId: true,
      currentClassInviteId: true,
    },
  });
  if (!user) throw new AiProviderProfileError("用户不存在。", 404);
  const classInviteId = user.role === "teacher"
    ? user.currentClassInviteId
    : user.inviteCodeId;
  const currentClass = classInviteId
    ? await prisma.inviteCode.findFirst({
        where: { id: classInviteId, level: "level_2", isActive: true },
        select: {
          id: true,
          code: true,
          courseName: true,
          className: true,
          teacherUserId: true,
          aiProviderAssignment: {
            select: {
              id: true,
              enforced: true,
              dailyTokenLimit: true,
              profile: { select: { id: true, name: true, baseUrl: true, model: true, level: true } },
            },
          },
        },
      })
    : null;
  return { user, currentClass };
}

export async function getClassAiProviderAssignment(userId: string) {
  const { user, currentClass } = await currentClassContext(userId);
  const assignment = currentClass?.aiProviderAssignment ?? null;
  const quotaStatus = user.role === "student" && assignment
    ? await getClassAiTokenQuotaStatus(user.id, assignment.id, assignment.dailyTokenLimit)
    : null;
  return presentClassProviderAssignment(currentClass, assignment, quotaStatus);
}

export async function selectClassAiProviderAssignment(userId: string) {
  const { user, currentClass } = await currentClassContext(userId);
  if (user.role !== "student") {
    throw new AiProviderProfileError("只有学生可以选用班级 AI Provider。", 403);
  }
  if (!currentClass?.aiProviderAssignment) {
    throw new AiProviderProfileError("当前班级尚未指定 AI Provider。", 404);
  }
  await prisma.aiProviderSelection.deleteMany({
    where: { ownerEmail: user.email.trim().toLowerCase() },
  });
  const assignment = currentClass.aiProviderAssignment;
  const quotaStatus = await getClassAiTokenQuotaStatus(user.id, assignment.id, assignment.dailyTokenLimit);
  return presentClassProviderAssignment(currentClass, assignment, quotaStatus);
}

export async function setClassAiProviderAssignment(
  userId: string,
  input: { profileId: string; enforced: boolean; dailyTokenLimit: number | null },
) {
  const { user, currentClass } = await currentClassContext(userId);
  if (user.role !== "teacher") {
    throw new AiProviderProfileError("只有教师可以为班级指定 AI Provider。", 403);
  }
  if (!currentClass) {
    throw new AiProviderProfileError("请先选择当前工作班级。", 400);
  }
  if (currentClass.teacherUserId !== user.id) {
    throw new AiProviderProfileError("只能配置自己管理的班级。", 403);
  }
  const ownerEmail = user.email.trim().toLowerCase();
  const profile = await prisma.aiProviderProfile.findFirst({
    where: { id: input.profileId, ownerEmail },
  });
  if (!profile) {
    throw new AiProviderProfileError("只能选择自己的 AI Provider Profile。", 404);
  }
  const assignment = await prisma.classAiProviderAssignment.upsert({
    where: { classInviteId: currentClass.id },
    create: {
      classInviteId: currentClass.id,
      profileId: profile.id,
      teacherUserId: user.id,
      enforced: input.enforced,
      dailyTokenLimit: input.dailyTokenLimit,
    },
    update: {
      profileId: profile.id,
      teacherUserId: user.id,
      enforced: input.enforced,
      dailyTokenLimit: input.dailyTokenLimit,
    },
    select: {
      id: true,
      enforced: true,
      dailyTokenLimit: true,
      profile: { select: { id: true, name: true, baseUrl: true, model: true, level: true } },
    },
  });
  return presentClassProviderAssignment(currentClass, assignment);
}

export async function clearClassAiProviderAssignment(userId: string) {
  const { user, currentClass } = await currentClassContext(userId);
  if (user.role !== "teacher") {
    throw new AiProviderProfileError("只有教师可以取消班级 AI Provider。", 403);
  }
  if (!currentClass) {
    throw new AiProviderProfileError("请先选择当前工作班级。", 400);
  }
  if (currentClass.teacherUserId !== user.id) {
    throw new AiProviderProfileError("只能配置自己管理的班级。", 403);
  }
  await prisma.classAiProviderAssignment.deleteMany({
    where: { classInviteId: currentClass.id, teacherUserId: user.id },
  });
  return presentClassProviderAssignment(currentClass, null);
}

function presentProfile(profile: {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  level: AiProviderLevel;
  updatedAt: Date;
}, selectedProfileId: string | null) {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    level: profile.level,
    apiKeyConfigured: profile.apiKey.trim().length > 0,
    apiKeyMasked: maskApiKey(profile.apiKey),
    selected: profile.id === selectedProfileId,
    updatedAt: profile.updatedAt,
  };
}

async function ownedProfile(userId: string, profileId: string) {
  const ownerEmail = await getAiProviderOwnerEmail(userId);
  const profile = await prisma.aiProviderProfile.findFirst({
    where: { id: profileId, ownerEmail },
  });
  if (!profile) throw new AiProviderProfileError("AI Provider Profile 不存在。", 404);
  return { ownerEmail, profile };
}

export async function listAiProviderProfiles(userId: string) {
  const ownerEmail = await getAiProviderOwnerEmail(userId);
  const [profiles, selection] = await Promise.all([
    prisma.aiProviderProfile.findMany({
      where: { ownerEmail },
      orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
    }),
    prisma.aiProviderSelection.findUnique({ where: { ownerEmail } }),
  ]);
  return profiles.map((profile) => presentProfile(profile, selection?.profileId ?? null));
}

export async function createAiProviderProfile(userId: string, input: AiProviderProfileInput) {
  const ownerEmail = await getAiProviderOwnerEmail(userId);
  const name = input.name.trim();
  if (!name) throw new AiProviderProfileError("请输入 Profile 名称。");
  const apiKey = input.apiKey?.trim();
  if (!apiKey) throw new AiProviderProfileError("请输入 API Key。");
  try {
    return await prisma.$transaction(async (transaction) => {
      const profile = await transaction.aiProviderProfile.create({
        data: {
          ownerEmail,
          name,
          baseUrl: normalizeProviderBaseUrl(input.baseUrl),
          apiKey,
          model: input.model.trim(),
          level: input.level,
        },
      });
      const existingSelection = await transaction.aiProviderSelection.findUnique({ where: { ownerEmail } });
      if (!existingSelection) {
        await transaction.aiProviderSelection.create({ data: { ownerEmail, profileId: profile.id } });
      }
      return presentProfile(profile, existingSelection?.profileId ?? profile.id);
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AiProviderProfileError("该 Profile 名称已存在。", 409);
    }
    throw error;
  }
}

export async function updateAiProviderProfile(
  userId: string,
  profileId: string,
  input: AiProviderProfileInput,
) {
  const { ownerEmail, profile: existing } = await ownedProfile(userId, profileId);
  const name = input.name.trim();
  if (!name) throw new AiProviderProfileError("请输入 Profile 名称。");
  const apiKey = input.apiKey?.trim() || existing.apiKey;
  try {
    const [profile, selection] = await Promise.all([
      prisma.aiProviderProfile.update({
        where: { id: profileId },
        data: {
          name,
          baseUrl: normalizeProviderBaseUrl(input.baseUrl),
          apiKey,
          model: input.model.trim(),
          level: input.level,
          temperature: null,
          contextWindowTokens: null,
        },
      }),
      prisma.aiProviderSelection.findUnique({ where: { ownerEmail } }),
    ]);
    return presentProfile(profile, selection?.profileId ?? null);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AiProviderProfileError("该 Profile 名称已存在。", 409);
    }
    throw error;
  }
}

export async function selectAiProviderProfile(userId: string, profileId: string) {
  const { ownerEmail, profile } = await ownedProfile(userId, profileId);
  await prisma.aiProviderSelection.upsert({
    where: { ownerEmail },
    create: { ownerEmail, profileId },
    update: { profileId },
  });
  return presentProfile(profile, profile.id);
}

export async function deleteAiProviderProfile(userId: string, profileId: string) {
  const { ownerEmail } = await ownedProfile(userId, profileId);
  return prisma.$transaction(async (transaction) => {
    const selection = await transaction.aiProviderSelection.findUnique({ where: { ownerEmail } });
    await transaction.aiProviderProfile.delete({ where: { id: profileId } });
    let selectedProfileId: string | null = selection?.profileId === profileId ? null : selection?.profileId ?? null;
    if (!selectedProfileId) {
      const replacement = await transaction.aiProviderProfile.findFirst({
        where: { ownerEmail },
        orderBy: [{ updatedAt: "desc" }, { name: "asc" }],
      });
      if (replacement) {
        await transaction.aiProviderSelection.upsert({
          where: { ownerEmail },
          create: { ownerEmail, profileId: replacement.id },
          update: { profileId: replacement.id },
        });
        selectedProfileId = replacement.id;
      }
    }
    return { deleted: true as const, selectedProfileId };
  });
}

/**
 * 功能：转换并展示设置。
 * 输入：`settings`（{ baseUrl: string; apiKey: string; model: string; temperature: number | null; }）提供设置。 `contextWindowTokens`（number）提供上下文 window Token 数量。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/ai-settings/ai-settings-application.service.ts:getAiSettings()`、`apps/server/src/application/ai-settings/ai-settings-application.service.ts:updateAiSettings()` 调用。
 */
function presentSettings(settings: {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number | null;
  reasoningEffort: string;
  source?: "personal" | "class";
}, contextWindowTokens: number) {
  const capabilities = resolveModelCapabilities({
    model: settings.model,
    baseUrl: settings.baseUrl,
  });
  return {
    baseUrl: settings.baseUrl,
    model: settings.model,
    temperature: settings.temperature ?? config.DEFAULT_AI_TEMPERATURE,
    contextWindowTokens,
    reasoningEffort: normalizeReasoningEffortForModel(
      settings.model,
      settings.reasoningEffort,
      settings.baseUrl,
    ),
    reasoningEffortOptions: capabilities.reasoningEffortOptions,
    apiKeyConfigured: settings.apiKey.trim().length > 0,
    apiKeyMasked: settings.source === "class" ? "" : maskApiKey(settings.apiKey),
    managedByClass: settings.source === "class",
    configured: true as const,
  };
}

/**
 * 功能：获取`ai` 设置。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/ai.router.ts 顶层流程` 调用；内部调用 `findUnique()`、`resolveContextWindowTokens()`、`presentSettings()`。
 */
export async function getAiSettings(userId: string) {
  const settings = await resolveSelectedAiProviderProfile(userId);
  if (!settings) return { configured: false as const };
  const contextWindowTokens = await resolveContextWindowTokens(
    settings.model,
    settings.contextWindowTokens ?? undefined,
    prisma,
    settings.baseUrl,
  );
  return presentSettings(settings, contextWindowTokens);
}

/**
 * 功能：获取`ai` 模型 模型档案。
 * 输入：`model`（string）提供模型。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/ai.router.ts 顶层流程` 调用；内部调用 `findModelProfileByName()`、`resolveModelCapabilities()`。
 */
export async function getAiModelProfile(model: string, baseUrl?: string | null) {
  const profile = await findModelProfileByName(model, prisma, baseUrl);
  if (!model.trim()) return null;
  const capabilities = resolveModelCapabilities({ model, baseUrl });
  return {
    providerName: profile?.providerName,
    modelName: profile?.modelName ?? model,
    contextWindowTokens: profile?.contextWindowTokens ?? capabilities.contextWindowTokens,
    effectiveInputTokens: profile?.effectiveInputTokens ?? capabilities.effectiveInputTokens,
    sourceUrl: profile?.sourceUrl,
    sourceNote: profile?.sourceNote,
    family: capabilities.family,
    reasoning: capabilities.reasoning,
    reasoningEffortOptions: capabilities.reasoningEffortOptions,
  };
}

/**
 * 功能：更新`ai` 设置。
 * 输入：`userId`（string）提供用户 id。 `input`（AiSettingsInput）提供当前操作所需的结构化输入。
 * 输出：返回该操作的完成状态；同步处理无结果时返回 void，异步处理返回 Promise。
 * 调用关系：由 `apps/server/src/transport/http/routes/ai.router.ts 顶层流程` 调用；内部调用 `findUnique()`、`resolveContextWindowTokens()`、`normalizeProviderBaseUrl()`、`upsert()`、`presentSettings()`。
 */
export async function updateAiSettings(userId: string, input: AiSettingsInput) {
  const ownerEmail = await getAiProviderOwnerEmail(userId);
  const existing = await resolvePersonalSelectedAiProviderProfile(userId);
  const apiKey = input.apiKey?.trim() || existing?.apiKey;
  if (!apiKey) throw new Error("请输入 API Key。");
  const contextWindowTokens = await resolveContextWindowTokens(
    input.model,
    input.contextWindowTokens,
    prisma,
    input.baseUrl,
  );
  const values = {
    baseUrl: normalizeProviderBaseUrl(input.baseUrl),
    apiKey,
    model: input.model.trim(),
    temperature: input.temperature,
    contextWindowTokens,
  };
  const selected = await prisma.aiProviderSelection.findUnique({ where: { ownerEmail } });
  const level = input.reasoningEffort === "high" || input.reasoningEffort === "low"
    ? input.reasoningEffort
    : AiProviderLevel.medium;
  const settings = selected
    ? await prisma.aiProviderProfile.update({ where: { id: selected.profileId }, data: { ...values, level } })
    : await prisma.$transaction(async (transaction) => {
        const profile = await transaction.aiProviderProfile.create({
          data: { ownerEmail, name: "默认配置", ...values, level },
        });
        await transaction.aiProviderSelection.create({ data: { ownerEmail, profileId: profile.id } });
        return profile;
      });
  return presentSettings({ ...settings, reasoningEffort: settings.level }, contextWindowTokens);
}

/**
 * 功能：重置`ai` `conversation` 上下文。
 * 输入：`userId`（string）提供用户 id。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/ai.router.ts 顶层流程` 调用；内部调用 `all()`、`findUnique()`、`findFirst()`、`resetWorkspaceAgentRuntime()`。
 */
export async function resetAiConversationContext(userId: string) {
  const [workspace, activeRun] = await Promise.all([
    prisma.workspace.findUnique({ where: { userId } }),
    prisma.agentRun.findFirst({
      where: {
        userId,
        finishedAt: null,
        status: { in: ACTIVE_AGENT_RUN_STATUSES },
      },
      select: { id: true },
    }),
  ]);
  if (!workspace || workspace.status !== WorkspaceStatus.ready) {
    throw new Error("工作区尚未就绪。");
  }
  if (activeRun) {
    throw new Error("请等待当前工作区任务结束后再重置会话状态。");
  }
  await resetWorkspaceAgentRuntime(workspace.path);
  return "会话运行状态已重置，现有记录仍会保留。如需全新会话，请在聊天框中使用 /new。";
}

async function prepareMeteredChat(
  userId: string,
  settings: ClassQuotaProvider,
  input: OpenAiCompatibleChatInput,
) {
  const quota = await beginClassAiChatQuota(
    userId,
    settings,
    `${input.systemPrompt}\n${input.userPrompt}`,
    input.maxTokens,
  );
  return {
    input: {
      ...input,
      maxTokens: quota.maxOutputTokens,
      onUsage: quota.settle,
    },
    release: quota.release,
  };
}

/**
 * 功能：执行`direct` `ai` 聊天。
 * 输入：`userId`（string）提供用户 id。 `prompt`（string）提供提示词。 `openFiles`（string[]）提供open 文件列表。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/ai.router.ts 顶层流程` 调用；内部调用 `all()`、`findUnique()`、`assertNoSymlinkPath()`、`ensureWorkspacePath()`、`readFile()`、`resolveContextWindowTokens()`。
 */
export async function runDirectAiChat(
  userId: string,
  prompt: string,
  openFiles: string[],
) {
  const [workspace, settings] = await Promise.all([
    prisma.workspace.findUnique({ where: { userId } }),
    resolveSelectedAiProviderProfile(userId),
  ]);
  if (!settings) throw new Error("请先在服务门户中配置 AI Provider。");
  if (!workspace || workspace.status !== WorkspaceStatus.ready) {
    throw new Error("工作区尚未就绪。");
  }
  const fileContexts = await Promise.all(
    openFiles.slice(0, 4).map(async (filePath) => {
      await assertNoSymlinkPath(workspace.path, filePath);
      const fullPath = ensureWorkspacePath(filePath, workspace.path);
      const content = await fs.readFile(fullPath, "utf8");
      return `File: ${filePath}\n${content.slice(0, 6000)}`;
    }),
  );
  const contextWindowTokens = await resolveContextWindowTokens(
    settings.model,
    settings.contextWindowTokens ?? undefined,
    prisma,
    settings.baseUrl,
  );
  const capabilities = resolveModelCapabilities({
    model: settings.model,
    baseUrl: settings.baseUrl,
    contextWindowTokens,
  });
  const metered = await prepareMeteredChat(userId, settings, {
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    temperature: settings.temperature ?? config.DEFAULT_AI_TEMPERATURE,
    maxTokens: capabilities.maxTokens,
    systemPrompt: "You are the Courseworks direct chat assistant. Answer in Markdown. You may use the provided open-file context, but you must not claim that you edited files, generated patches, ran make, or ran QEMU.",
    userPrompt: [`Question:\n${prompt}`, ...fileContexts].join("\n\n"),
  });
  try {
    return await withUserAiRequestSlot(userId, () => runOpenAiCompatibleChat(metered.input));
  } catch (error) {
    await metered.release();
    throw error;
  }
}

async function homeworkTutorChatInput(
  userId: string,
  questionContext: string,
  prompt: string,
  history: HomeworkTutorTurn[],
  mode: HomeworkTutorMode,
  reviewContext?: string,
) {
  const settings = await resolveSelectedAiProviderProfile(userId);
  if (!settings) throw new Error("请先在服务门户中配置 AI Provider。");

  const contextWindowTokens = await resolveContextWindowTokens(
    settings.model,
    settings.contextWindowTokens ?? undefined,
    prisma,
    settings.baseUrl,
  );
  const capabilities = resolveModelCapabilities({
    model: settings.model,
    baseUrl: settings.baseUrl,
    contextWindowTokens,
  });

  return prepareMeteredChat(userId, settings, {
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    temperature: settings.temperature ?? config.DEFAULT_AI_TEMPERATURE,
    maxTokens: Math.min(capabilities.maxTokens, 4_096),
    reasoningEffort: settings.reasoningEffort,
    operation: mode === "review" ? "homeworks-review" : "homeworks-guidance",
    systemPrompt: [
      buildHomeworkTutorSystemPrompt(questionContext, mode, reviewContext),
      buildRuntimeAiIdentityPrompt(settings),
    ].join("\n\n"),
    userPrompt: buildHomeworkTutorUserPrompt(history, prompt),
  });
}

export async function runHomeworkTutorChat(
  userId: string,
  questionContext: string,
  prompt: string,
  history: HomeworkTutorTurn[],
  mode: HomeworkTutorMode,
  reviewContext?: string,
) {
  const metered = await homeworkTutorChatInput(
      userId,
      questionContext,
      prompt,
      history,
      mode,
      reviewContext,
    );
  try {
    return await withUserAiRequestSlot(userId, () => runOpenAiCompatibleChat(metered.input));
  } catch (error) {
    await metered.release();
    throw error;
  }
}

export async function streamHomeworkTutorChat(
  userId: string,
  questionContext: string,
  prompt: string,
  history: HomeworkTutorTurn[],
  mode: HomeworkTutorMode,
  reviewContext?: string,
) {
  const metered = await homeworkTutorChatInput(
      userId,
      questionContext,
      prompt,
      history,
      mode,
      reviewContext,
    );
  try {
    return await withUserAiStreamSlot(userId, () => streamOpenAiCompatibleChat(metered.input));
  } catch (error) {
    await metered.release();
    throw error;
  }
}

async function studyTutorChatInput(
  userId: string,
  materialContext: string,
  prompt: string,
  history: StudyTutorTurn[],
) {
  const settings = await resolveSelectedAiProviderProfile(userId);
  if (!settings) throw new Error("请先在服务门户中配置 AI Provider。");
  const contextWindowTokens = await resolveContextWindowTokens(
    settings.model,
    settings.contextWindowTokens ?? undefined,
    prisma,
    settings.baseUrl,
  );
  const capabilities = resolveModelCapabilities({
    model: settings.model,
    baseUrl: settings.baseUrl,
    contextWindowTokens,
  });
  return prepareMeteredChat(userId, settings, {
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    temperature: settings.temperature ?? config.DEFAULT_AI_TEMPERATURE,
    maxTokens: Math.min(capabilities.maxTokens, 4_096),
    reasoningEffort: settings.reasoningEffort,
    operation: "slideshow-study",
    systemPrompt: [
      buildStudyTutorSystemPrompt(materialContext),
      buildRuntimeAiIdentityPrompt(settings),
    ].join("\n\n"),
    userPrompt: buildStudyTutorUserPrompt(history, prompt),
  });
}

export async function streamStudyTutorChat(
  userId: string,
  materialContext: string,
  prompt: string,
  history: StudyTutorTurn[],
) {
  const metered = await studyTutorChatInput(userId, materialContext, prompt, history);
  try {
    return await withUserAiStreamSlot(userId, () => streamOpenAiCompatibleChat(metered.input));
  } catch (error) {
    await metered.release();
    throw error;
  }
}

/**
 * 功能：测试`ai` 设置。
 * 输入：`userId`（string）提供用户 id。 `input`（Partial<AiSettingsInput>）提供当前操作所需的结构化输入。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/ai.router.ts 顶层流程`、`apps/web/src/features/workspace/WorkspacePage.tsx:WorkspacePage()` 调用；内部调用 `findUnique()` 和 `testAiProvider()`。
 */
export async function testAiSettings(userId: string, input: Partial<AiSettingsInput>) {
  const existing = await resolvePersonalSelectedAiProviderProfile(userId);
  const baseUrl = input.baseUrl ?? existing?.baseUrl;
  const model = input.model ?? existing?.model;
  const apiKey = input.apiKey?.trim() || existing?.apiKey;
  const reasoningEffort = normalizeReasoningEffortForModel(
    model ?? "",
    input.reasoningEffort ?? existing?.reasoningEffort,
    baseUrl,
  );
  if (!baseUrl || !model || !apiKey) {
    throw new Error("测试前请填写 Base URL、模型和 API Key。");
  }
  return testAiProvider({ apiKey, baseUrl, model, reasoningEffort });
}

/**
 * 功能：发现`ai` Provider 模型列表。
 * 输入：`userId`（string）提供用户 id。 `input`（{ baseUrl: string; apiKey?: string }）提供当前操作所需的结构化输入。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/transport/http/routes/ai.router.ts 顶层流程` 调用；内部调用 `findUnique()` 和 `listAiProviderModels()`。
 */
export async function discoverAiProviderModels(
  userId: string,
  input: { baseUrl: string; apiKey?: string; profileId?: string },
) {
  const existing = input.profileId
    ? (await ownedProfile(userId, input.profileId)).profile
    : await resolvePersonalSelectedAiProviderProfile(userId);
  const apiKey = input.apiKey?.trim() || existing?.apiKey;
  if (!apiKey) {
    throw new Error("加载服务商模型需要 API Key。");
  }
  const models = await listAiProviderModels({
    baseUrl: input.baseUrl,
    apiKey,
  });
  return { models };
}

export async function testAiProviderProfile(
  userId: string,
  input: Partial<AiProviderProfileInput> & { profileId?: string },
) {
  const existing = input.profileId
    ? (await ownedProfile(userId, input.profileId)).profile
    : await resolvePersonalSelectedAiProviderProfile(userId);
  const baseUrl = input.baseUrl ?? existing?.baseUrl;
  const model = input.model ?? existing?.model;
  const apiKey = input.apiKey?.trim() || existing?.apiKey;
  const level = input.level ?? existing?.level ?? AiProviderLevel.medium;
  if (!baseUrl || !model || !apiKey) {
    throw new AiProviderProfileError("测试前请填写 Base URL、模型和 API Key。");
  }
  return testAiProvider({ apiKey, baseUrl, model, reasoningEffort: level });
}
