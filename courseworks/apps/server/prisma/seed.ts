/**
 * 文件作用：初始化 Courseworks 数据库中的基础账号与业务数据。
 * 模块位置：`apps/server/prisma/seed.ts`，属于后端数据库初始化层。
 * 重要函数：`main()` 负责处理`main`。
 */
import "dotenv/config";

import { ensureConfiguredSuperuser } from "../src/application/identity/account-application.service.js";
import { prisma } from "../src/infrastructure/prisma/client.js";
import { seedModelProfiles } from "../src/modules/ai-settings/model-profile.service.js";

/**
 * 功能：处理`main`。
 * 输入：无显式输入参数。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/prisma/seed.ts 顶层流程` 调用；内部调用 `seedModelProfiles()`、`findUnique()`、`hashPassword()`、`update()`、`create()`。
 */
async function main() {
  await seedModelProfiles(prisma);
  await ensureConfiguredSuperuser();
}

main()
  .catch((error) => {
    console.error("Seed failed.");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
