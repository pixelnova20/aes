import assert from "node:assert/strict";
import test from "node:test";

import { recentTutorHistory } from "./tutor-history.js";

test("keeps the newest complete tutor turns within the character budget", () => {
  const history = [
    { role: "user" as const, content: "a".repeat(5) },
    { role: "assistant" as const, content: "b".repeat(5) },
    { role: "user" as const, content: "c".repeat(5) },
  ];

  assert.deepEqual(recentTutorHistory(history, 10), history.slice(1));
});

test("does not cut a long tutor turn in the middle", () => {
  const history = [
    { role: "assistant" as const, content: "long response" },
  ];

  assert.deepEqual(recentTutorHistory(history, 4), []);
});
