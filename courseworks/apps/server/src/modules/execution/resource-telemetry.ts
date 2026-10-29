import { createEventLogger } from "@aes/management";
import { randomUUID } from "node:crypto";

const bootId = randomUUID();
const logger = createEventLogger("courseworks", "resources");

export function resourceEvent(event: string, fields: Record<string, unknown> = {}) {
  logger.write(event, { ...fields, bootId });
}

export function resourceIds(metadata: Record<string, string | undefined>) {
  return { workspaceId: metadata.workspaceId, runId: metadata.runId, sessionId: metadata.sessionId, userId: metadata.userId };
}

export function flushResourceEvents() { return logger.flush(); }
