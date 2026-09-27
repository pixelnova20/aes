import assert from "node:assert/strict";
import test from "node:test";

import { isUserRole, USER_ROLES } from "./role-policy.js";

test("accepts every managed user role", () => {
  for (const role of Object.values(USER_ROLES)) {
    assert.equal(isUserRole(role), true);
  }
});

test("rejects unknown user roles", () => {
  assert.equal(isUserRole("administrator"), false);
  assert.equal(isUserRole(""), false);
});
