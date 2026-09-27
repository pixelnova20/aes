/**
 * 文件作用：实现后端“身份认证”业务模块中的 `hashPassword`、`comparePassword` 等能力。
 * 模块位置：`apps/server/src/modules/identity/password.ts`，属于后端“身份认证”业务模块。
 * 重要函数：`hashPassword()` 负责计算哈希密码；`comparePassword()` 负责比较密码。
 */
import bcrypt from "bcrypt";

const SALT_ROUNDS = 10;

/**
 * 功能：计算哈希密码。
 * 输入：`password`（string）提供密码。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/prisma/seed.ts:main()`、`apps/server/src/application/admin/admin-application.service.ts:createAdministrator()`、`apps/server/src/application/admin/admin-application.service.ts:resetAdministratorPassword()`、`apps/server/src/application/identity/account-application.service.ts:registerAccount()` 调用；内部调用 `hash()`。
 */
export function hashPassword(password: string) {
  // 统一密码哈希入口，避免业务代码自己决定加密策略。
  return bcrypt.hash(password, SALT_ROUNDS);
}

/**
 * 功能：比较密码。
 * 输入：`password`（string）提供密码。 `hash`（string）提供hash。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/application/identity/account-application.service.ts:loginAccount()` 调用；内部调用 `compare()`。
 */
export function comparePassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}
