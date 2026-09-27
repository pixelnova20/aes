import assert from "node:assert/strict";
import test from "node:test";

import {
  AiConcurrencyLimitError,
  UserAiConcurrencyLimiter,
} from "./user-ai-concurrency.service.js";

test("limits concurrent AI requests per user without coupling different users", () => {
  const limiter = new UserAiConcurrencyLimiter(1);
  const release = limiter.acquire("student-a");

  assert.equal(limiter.active("student-a"), 1);
  assert.throws(() => limiter.acquire("student-a"), AiConcurrencyLimitError);

  const releaseOther = limiter.acquire("student-b");
  releaseOther();
  release();
  assert.equal(limiter.active("student-a"), 0);
});

test("release functions are idempotent", () => {
  const limiter = new UserAiConcurrencyLimiter(1);
  const release = limiter.acquire("student-a");
  release();
  release();
  assert.equal(limiter.active("student-a"), 0);
  limiter.acquire("student-a")();
});

test("releases request slots after success and failure", async () => {
  const limiter = new UserAiConcurrencyLimiter(1);
  assert.equal(await limiter.run("student-a", async () => "done"), "done");
  assert.equal(limiter.active("student-a"), 0);

  await assert.rejects(
    limiter.run("student-a", async () => { throw new Error("provider failed"); }),
    /provider failed/,
  );
  assert.equal(limiter.active("student-a"), 0);
});

test("holds stream slots until iteration finishes", async () => {
  const limiter = new UserAiConcurrencyLimiter(1);
  const stream = await limiter.stream("student-a", async () => (async function* () {
    yield "first";
    yield "second";
  })());

  assert.equal(limiter.active("student-a"), 1);
  const output: string[] = [];
  for await (const item of stream) output.push(item);
  assert.deepEqual(output, ["first", "second"]);
  assert.equal(limiter.active("student-a"), 0);
});
