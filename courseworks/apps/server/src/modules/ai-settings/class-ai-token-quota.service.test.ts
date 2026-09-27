import assert from "node:assert/strict";
import test from "node:test";

import {
  classAiUsageDate,
  estimateAiTokens,
  hasClassAiDailyTokenQuota,
  normalizeClassAiDailyTokenLimit,
} from "./class-ai-token-quota.service.js";

test("uses the Shanghai calendar day for daily quotas", () => {
  assert.equal(classAiUsageDate(new Date("2026-09-24T16:01:00.000Z")), "2026-09-25");
});

test("estimates Chinese and Latin input without returning zero", () => {
  assert.equal(estimateAiTokens("答案是B"), 4);
  assert.equal(estimateAiTokens("abcdefgh"), 2);
  assert.equal(estimateAiTokens(""), 1);
});

test("applies a daily quota only to a referenced class profile", () => {
  assert.equal(hasClassAiDailyTokenQuota({
    source: "class",
    classAssignmentId: "assignment-1",
    dailyTokenLimit: 100_000,
  }), true);
  assert.equal(hasClassAiDailyTokenQuota({
    source: "personal",
    classAssignmentId: "assignment-1",
    dailyTokenLimit: 100_000,
  }), false);
  assert.equal(hasClassAiDailyTokenQuota({
    source: "class",
    classAssignmentId: "assignment-1",
    dailyTokenLimit: null,
  }), false);
});

test("treats zero as an unlimited class quota", () => {
  assert.equal(normalizeClassAiDailyTokenLimit(0), null);
  assert.equal(normalizeClassAiDailyTokenLimit(null), null);
  assert.equal(normalizeClassAiDailyTokenLimit(100_000), 100_000);
});
