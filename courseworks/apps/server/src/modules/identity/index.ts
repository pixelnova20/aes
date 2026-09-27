/**
 * 文件作用：汇总并导出后端“身份认证”业务模块的公共 API。
 * 模块位置：`apps/server/src/modules/identity/index.ts`，属于后端“身份认证”业务模块。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
export {
  signHomeworksSsoToken,
  signServiceSsoToken,
  signToken,
  verifyHomeworkTutorToken,
  verifyToken,
} from "./jwt.js";
export { comparePassword, hashPassword } from "./password.js";
export { USER_ROLES, isUserRole, type UserRole } from "@all-together/management";
