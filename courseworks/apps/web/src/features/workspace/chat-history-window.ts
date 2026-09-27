import type { ChatEntry } from "./workspace-types";

export const DEFAULT_VISIBLE_CHAT_ENTRIES = 60;
export const CHAT_HISTORY_PAGE_SIZE = 40;

export function getChatHistoryWindow(
  history: ChatEntry[],
  visibleCount: number,
): { entries: ChatEntry[]; hiddenCount: number } {
  const count = Math.max(0, Math.floor(visibleCount));
  const start = Math.max(0, history.length - count);
  return {
    entries: history.slice(start),
    hiddenCount: start,
  };
}

export function nextVisibleChatEntryCount(current: number, total: number): number {
  return Math.min(total, Math.max(0, current) + CHAT_HISTORY_PAGE_SIZE);
}
