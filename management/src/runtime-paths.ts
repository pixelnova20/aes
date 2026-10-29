import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function aesRoot() {
  return process.env.AES_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function productionDataRoot() {
  return path.resolve(process.env.AES_DATA_ROOT ?? path.join(aesRoot(), "production-data"));
}

export function logRoot() {
  return path.resolve(process.env.AES_LOG_ROOT ?? path.join(aesRoot(), "logs"));
}

export function ensureLogDirectory(channel: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(channel)) throw new Error("Invalid log channel");
  const directory = path.join(logRoot(), channel);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}
