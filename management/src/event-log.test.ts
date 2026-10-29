import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEventLogger } from "./event-log.js";

test("event logging rotates private files and contains filesystem failures", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aes-log-test-"));
  const previous = process.env.AES_LOG_ROOT;
  process.env.AES_LOG_ROOT = directory;
  try {
    const logger = createEventLogger("courseworks", "auth", 250);
    for (let i = 0; i < 5; i++) { logger.write("login_success", { userId: "example", sequence: i }); await logger.flush(); }
    const file = path.join(directory, "auth", `courseworks-${process.pid}.jsonl`);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.ok((await fs.stat(file + ".1")).size > 0);
    const row = JSON.parse((await fs.readFile(file, "utf8")).trim());
    assert.equal(row.event, "login_success");
    assert.equal(row.sequence, 4);
    assert.equal(row.service, "courseworks");
    assert.throws(() => createEventLogger("../private"));
    process.env.AES_LOG_ROOT = path.join(file, "unwritable");
    logger.write("failed_destination");
    await logger.flush();
  } finally {
    if (previous === undefined) delete process.env.AES_LOG_ROOT; else process.env.AES_LOG_ROOT = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
