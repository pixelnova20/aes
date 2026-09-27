/**
 * 文件作用：定义Courseworks 应用源码使用的数据结构与类型契约。
 * 模块位置：`apps/server/src/types/express.d.ts`，属于Courseworks 应用源码。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import type { UserRole } from "../modules/identity/index.js";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        role: UserRole;
        email: string;
        homeworkTutorMode?: "guidance" | "review";
      };
    }
  }
}

export {};
