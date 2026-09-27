import assert from "node:assert/strict";
import test from "node:test";

import type { ChatEntry } from "./workspace-types";
import {
  CHAT_HISTORY_PAGE_SIZE,
  DEFAULT_VISIBLE_CHAT_ENTRIES,
  getChatHistoryWindow,
  nextVisibleChatEntryCount,
} from "./chat-history-window";

function history(length: number): ChatEntry[] {
  return Array.from({ length }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Message ${index}`,
  }));
}

test("chat history window keeps only the newest entries by default", () => {
  const result = getChatHistoryWindow(history(200), DEFAULT_VISIBLE_CHAT_ENTRIES);

  assert.equal(result.entries.length, DEFAULT_VISIBLE_CHAT_ENTRIES);
  assert.equal(result.hiddenCount, 140);
  assert.equal(result.entries[0]?.id, "message-140");
  assert.equal(result.entries.at(-1)?.id, "message-199");
});

test("chat history window returns all entries when the history is short", () => {
  const result = getChatHistoryWindow(history(12), DEFAULT_VISIBLE_CHAT_ENTRIES);

  assert.equal(result.hiddenCount, 0);
  assert.equal(result.entries.length, 12);
});

test("loading older messages advances by one bounded page", () => {
  assert.equal(nextVisibleChatEntryCount(60, 200), 60 + CHAT_HISTORY_PAGE_SIZE);
  assert.equal(nextVisibleChatEntryCount(180, 200), 200);
});
