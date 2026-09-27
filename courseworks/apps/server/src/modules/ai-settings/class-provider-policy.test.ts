import assert from "node:assert/strict";
import test from "node:test";

import { shouldUseForcedClassProvider } from "./provider-profile.service.js";

test("only students are pinned to an enforced class provider", () => {
  assert.equal(shouldUseForcedClassProvider("student", true), true);
  assert.equal(shouldUseForcedClassProvider("student", false), false);
  assert.equal(shouldUseForcedClassProvider("teacher", true), false);
  assert.equal(shouldUseForcedClassProvider("ta", true), false);
});
