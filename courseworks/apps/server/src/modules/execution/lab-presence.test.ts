import assert from "node:assert/strict";
import test from "node:test";
import { LabPresence } from "./lab-presence.js";

test("disconnect waits 60 seconds; reconnect cancels expiry", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const expired: string[] = [];
  const presence = new LabPresence((id) => expired.push(id));
  const close = presence.connect("workspace");
  close();
  t.mock.timers.tick(59_999);
  assert.deepEqual(expired, []);
  const closeAgain = presence.connect("workspace");
  t.mock.timers.tick(60_000);
  assert.deepEqual(expired, []);
  closeAgain();
  t.mock.timers.tick(60_000);
  assert.deepEqual(expired, ["workspace"]);
});

test("multiple pages protect all Bash tabs; duplicate close is harmless", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const expired: string[] = [];
  const presence = new LabPresence((id) => expired.push(id));
  const a = presence.connect("workspace");
  const b = presence.connect("workspace");
  a(true);
  a();
  t.mock.timers.tick(120_000);
  assert.deepEqual(expired, []);
  b(true);
  b();
  assert.deepEqual(expired, ["workspace"]);
  t.mock.timers.tick(120_000);
  assert.equal(expired.length, 1);
});

test("a created shell without a connected page is reclaimed; other workspaces are isolated", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const expired: string[] = [];
  const presence = new LabPresence((id) => expired.push(id));
  presence.connect("active");
  presence.track("abandoned");
  t.mock.timers.tick(30_000);
  presence.track("abandoned");
  t.mock.timers.tick(30_000);
  assert.deepEqual(expired, ["abandoned"]);
});
