import { Prisma } from "@prisma/client";

import { prisma } from "../../infrastructure/prisma/client.js";

export type ClassQuotaProvider = {
  source?: "personal" | "class";
  classAssignmentId?: string | null;
  dailyTokenLimit?: number | null;
};

export type AiTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export class AiDailyTokenQuotaError extends Error {
  readonly status = 429;

  constructor(readonly limit: number) {
    super(`今日班级 AI Token 配额（${limit.toLocaleString()}）已用完，请明日再试或改用自己的 AI Provider。`);
    this.name = "AiDailyTokenQuotaError";
  }
}

const SHANGHAI_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function classAiUsageDate(now = new Date()) {
  const parts = Object.fromEntries(
    SHANGHAI_DATE.formatToParts(now)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function estimateAiTokens(text: string) {
  let cjk = 0;
  let other = 0;
  for (const character of text) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) cjk += 1;
    else other += 1;
  }
  return Math.max(1, cjk + Math.ceil(other / 4));
}

export function normalizeClassAiDailyTokenLimit(value: number | null) {
  return value === null || value === 0 ? null : value;
}

export function hasClassAiDailyTokenQuota(settings: ClassQuotaProvider) {
  return settings.source === "class"
    && Boolean(settings.classAssignmentId)
    && Boolean(settings.dailyTokenLimit);
}

function quotaIdentity(userId: string, settings: ClassQuotaProvider) {
  if (!hasClassAiDailyTokenQuota(settings)) return null;
  return {
    assignmentId: settings.classAssignmentId!,
    userId,
    usageDate: classAiUsageDate(),
    limit: settings.dailyTokenLimit!,
  };
}

async function reserveTokens(
  identity: NonNullable<ReturnType<typeof quotaIdentity>>,
  desiredTokens: number | "remaining",
) {
  return prisma.$transaction(async (transaction) => {
    await transaction.classAiTokenUsage.upsert({
      where: {
        assignmentId_userId_usageDate: {
          assignmentId: identity.assignmentId,
          userId: identity.userId,
          usageDate: identity.usageDate,
        },
      },
      create: {
        assignmentId: identity.assignmentId,
        userId: identity.userId,
        usageDate: identity.usageDate,
      },
      update: {},
    });
    const usage = await transaction.classAiTokenUsage.findUniqueOrThrow({
      where: {
        assignmentId_userId_usageDate: {
          assignmentId: identity.assignmentId,
          userId: identity.userId,
          usageDate: identity.usageDate,
        },
      },
    });
    const remaining = Math.max(0, identity.limit - usage.usedTokens - usage.reservedTokens);
    if (remaining <= 0) throw new AiDailyTokenQuotaError(identity.limit);
    const reservation = desiredTokens === "remaining"
      ? remaining
      : Math.min(remaining, Math.max(1, desiredTokens));
    await transaction.classAiTokenUsage.update({
      where: { id: usage.id },
      data: { reservedTokens: { increment: reservation } },
    });
    return reservation;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function applyReservation(
  identity: NonNullable<ReturnType<typeof quotaIdentity>>,
  reservedTokens: number,
  usedTokens: number,
) {
  if (reservedTokens <= 0 && usedTokens <= 0) return;
  await prisma.classAiTokenUsage.update({
    where: {
      assignmentId_userId_usageDate: {
        assignmentId: identity.assignmentId,
        userId: identity.userId,
        usageDate: identity.usageDate,
      },
    },
    data: {
      reservedTokens: { decrement: Math.max(0, reservedTokens) },
      usedTokens: { increment: Math.max(0, Math.ceil(usedTokens)) },
    },
  });
}

export async function beginClassAiChatQuota(
  userId: string,
  settings: ClassQuotaProvider,
  inputText: string,
  requestedMaxOutputTokens: number,
) {
  const identity = quotaIdentity(userId, settings);
  if (!identity) {
    return {
      maxOutputTokens: requestedMaxOutputTokens,
      metered: false,
      settle: async (_usage: AiTokenUsage) => {},
      release: async () => {},
    };
  }

  const estimatedInputTokens = estimateAiTokens(inputText);
  const reservedTokens = await reserveTokens(
    identity,
    estimatedInputTokens + requestedMaxOutputTokens,
  );
  const maxOutputTokens = reservedTokens - estimatedInputTokens;
  if (maxOutputTokens < 1) {
    await applyReservation(identity, reservedTokens, 0);
    throw new AiDailyTokenQuotaError(identity.limit);
  }

  let finished = false;
  return {
    maxOutputTokens,
    metered: true,
    settle: async (usage: AiTokenUsage) => {
      if (finished) return;
      finished = true;
      const actual = usage.totalTokens > 0
        ? usage.totalTokens
        : usage.inputTokens + usage.outputTokens;
      await applyReservation(identity, reservedTokens, actual);
    },
    release: async () => {
      if (finished) return;
      finished = true;
      await applyReservation(identity, reservedTokens, 0);
    },
  };
}

export async function beginClassAiAgentQuota(userId: string, settings: ClassQuotaProvider) {
  const identity = quotaIdentity(userId, settings);
  if (!identity) {
    return {
      metered: false,
      consume: async (_tokens: number) => false,
      release: async () => {},
    };
  }

  let reservedTokens = await reserveTokens(identity, "remaining");
  let released = false;
  return {
    metered: true,
    consume: async (tokens: number) => {
      if (released || tokens <= 0) return false;
      const charged = Math.max(0, Math.ceil(tokens));
      const fromReservation = Math.min(reservedTokens, charged);
      reservedTokens -= fromReservation;
      await applyReservation(identity, fromReservation, charged);
      return charged > fromReservation || reservedTokens <= 0;
    },
    release: async () => {
      if (released) return;
      released = true;
      const remainder = reservedTokens;
      reservedTokens = 0;
      await applyReservation(identity, remainder, 0);
    },
  };
}

export async function getClassAiTokenQuotaStatus(
  userId: string,
  assignmentId: string,
  dailyTokenLimit: number | null,
) {
  if (!dailyTokenLimit) return null;
  const usageDate = classAiUsageDate();
  const usage = await prisma.classAiTokenUsage.findUnique({
    where: {
      assignmentId_userId_usageDate: { assignmentId, userId, usageDate },
    },
    select: { usedTokens: true },
  });
  const usedTokens = usage?.usedTokens ?? 0;
  return {
    usageDate,
    dailyTokenLimit,
    usedTokens,
    remainingTokens: Math.max(0, dailyTokenLimit - usedTokens),
  };
}
