import assert from "node:assert/strict";
import { test } from "node:test";

import { assertAccountsCanBeDeleted } from "./account-archive.service.js";

test("account deletion rejects every super administrator", () => {
  assert.throws(
    () => assertAccountsCanBeDeleted([{ role: "student" }, { role: "super_admin" }]),
    /cannot be deleted/,
  );
});

test("account deletion accepts managed roles", () => {
  assert.doesNotThrow(() => assertAccountsCanBeDeleted([
    { role: "teacher" },
    { role: "ta" },
    { role: "student" },
  ]));
});
