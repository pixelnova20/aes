import { AiProviderLevel } from "@prisma/client";

import { config } from "../../config/index.js";
import { prisma } from "../../infrastructure/prisma/client.js";

export const DEFAULT_AI_PROVIDER_PROFILE = {
  name: "默认配置",
  baseUrl: "http://127.0.0.1:11434/v1",
  apiKey: "not-configured",
  model: "gpt-oss:120b",
  level: AiProviderLevel.medium,
  temperature: 0.6,
  contextWindowTokens: 256_000,
} as const;

export function normalizeAiProviderOwnerEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function getAiProviderOwnerEmail(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user) throw new Error("用户不存在。");
  return normalizeAiProviderOwnerEmail(user.email);
}

function asRuntimeProfile<T extends {
  temperature: number | null;
  level: AiProviderLevel;
}>(
  profile: T,
  source: "personal" | "class",
  assignment?: { id: string; dailyTokenLimit: number | null },
) {
  return {
    ...profile,
    source,
    classAssignmentId: assignment?.id ?? null,
    dailyTokenLimit: assignment?.dailyTokenLimit ?? null,
    temperature: profile.temperature ?? config.DEFAULT_AI_TEMPERATURE,
    maxTokens: null,
    reasoningEffort: profile.level,
  };
}

export function shouldUseForcedClassProvider(role: string, enforced: boolean) {
  return role === "student" && enforced;
}

function isBundledPlaceholderProvider(profile: {
  name: string;
  baseUrl: string;
  model: string;
}) {
  return profile.baseUrl === DEFAULT_AI_PROVIDER_PROFILE.baseUrl
    && profile.model === DEFAULT_AI_PROVIDER_PROFILE.model;
}

export async function resolvePersonalSelectedAiProviderProfile(userId: string) {
  const ownerEmail = await getAiProviderOwnerEmail(userId);
  const selection = await prisma.aiProviderSelection.findUnique({
    where: { ownerEmail },
    include: { profile: true },
  });
  if (!selection || selection.profile.ownerEmail !== ownerEmail) return null;
  return asRuntimeProfile(selection.profile, "personal");
}

export async function resolveSelectedAiProviderProfile(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, inviteCodeId: true },
  });
  if (!user) throw new Error("用户不存在。");

  if (user.inviteCodeId && user.role === "student") {
    const assignment = await prisma.classAiProviderAssignment.findUnique({
      where: { classInviteId: user.inviteCodeId },
      include: { profile: true },
    });
    if (assignment) {
      if (shouldUseForcedClassProvider(user.role, assignment.enforced)) {
        return asRuntimeProfile(assignment.profile, "class", assignment);
      }
      const personal = await resolvePersonalSelectedAiProviderProfile(userId);
      if (!personal || isBundledPlaceholderProvider(personal)) {
        return asRuntimeProfile(assignment.profile, "class", assignment);
      }
      return personal;
    }
  }

  return resolvePersonalSelectedAiProviderProfile(userId);
}
