/**
 * Bootstrap the current Prisma schema only when the configured database is empty.
 * Existing installations continue to use the normal incremental migration path.
 */
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import { config as loadDotenv } from "dotenv";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const courseworksRoot = path.resolve(scriptDirectory, "../../..");
const migrationRoot = path.join(courseworksRoot, "apps/server/prisma/migrations");
const schemaPath = path.join(courseworksRoot, "apps/server/prisma/schema.prisma");
const prismaBinary = path.join(courseworksRoot, "node_modules/.bin/prisma");

loadDotenv({ path: path.join(courseworksRoot, ".env") });

function runPrisma(...args) {
  const result = spawnSync(prismaBinary, args, {
    cwd: courseworksRoot,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const prisma = new PrismaClient();
let applicationTableCount;
try {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) AS tableCount
      FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name <> '_prisma_migrations'
  `);
  applicationTableCount = Number(rows[0]?.tableCount ?? 0);
} finally {
  await prisma.$disconnect();
}

if (applicationTableCount > 0) {
  console.log(`Database already contains ${applicationTableCount} application tables; using incremental migrations.`);
  process.exit(0);
}

console.log("Empty database detected; creating the current Courseworks schema.");
runPrisma("db", "push", "--skip-generate", "--schema", schemaPath);

const migrations = (await readdir(migrationRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

for (const migration of migrations) {
  runPrisma("migrate", "resolve", "--applied", migration, "--schema", schemaPath);
}

console.log(`Recorded ${migrations.length} historical migrations for the new database.`);
