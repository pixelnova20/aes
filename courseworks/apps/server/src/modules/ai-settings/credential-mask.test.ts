import assert from "node:assert/strict";
import test from "node:test";

import { maskApiKey } from "./credential-mask.js";

test("masks the middle of an API key without exposing its length", () => {
  assert.equal(
    maskApiKey("test-api-key-0123456789abcdef"),
    "test************cdef",
  );
  assert.equal(maskApiKey("sk-short-key"), "sk-s************-key");
});

test("fully masks short API keys", () => {
  assert.equal(maskApiKey("12345678"), "********");
  assert.equal(maskApiKey(""), "");
});
