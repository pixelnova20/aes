import fs from "node:fs/promises";
import path from "node:path";
import { logRoot } from "./runtime-paths.js";

// Each process owns its files, so Gunicorn workers and Node never race rotation.
export function createEventLogger(service: string, channel = "operations", maxBytes = 20 * 1024 * 1024) {
  if (![service, channel].every(s => /^[a-z][a-z0-9-]*$/.test(s))) throw new Error("Invalid log name");
  let tail = Promise.resolve();
  let pending = 0;
  let dropped = 0;
  let lastErrorAt = 0;
  return {
    write(event: string, fields: Record<string, unknown> = {}) {
      if (pending >= 256) { dropped++; return; }
      const line = JSON.stringify({ ...fields, schemaVersion: 1, time: new Date().toISOString(), service, event, pid: process.pid, droppedEvents: dropped }) + "\n";
      dropped = 0;
      pending++;
      tail = tail.then(async () => {
        const directory = path.join(logRoot(), channel);
        const file = path.join(directory, `${service}-${process.pid}.jsonl`);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const size = await fs.stat(file).then(s => s.size).catch(() => 0);
        if (size + Buffer.byteLength(line) > maxBytes) {
          await fs.rm(`${file}.9`, { force: true });
          for (let i = 8; i >= 1; i--) await fs.rename(`${file}.${i}`, `${file}.${i + 1}`).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
          await fs.rename(file, `${file}.1`).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
        }
        await fs.appendFile(file, line, { mode: 0o600 });
      }).catch((e: NodeJS.ErrnoException) => {
        dropped++;
        if (Date.now() - lastErrorAt > 60000) {
          lastErrorAt = Date.now();
          console.error(JSON.stringify({ event: "log_write_failed", service, channel, code: e.code ?? "UNKNOWN" }));
        }
      }).finally(() => { pending--; });
    },
    flush() { return tail; },
  };
}
