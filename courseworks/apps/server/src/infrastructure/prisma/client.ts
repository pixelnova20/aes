/**
 * 文件作用：提供后端基础设施层所需的声明和装配。
 * 模块位置：`apps/server/src/infrastructure/prisma/client.ts`，属于后端基础设施层。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import { PrismaClient } from "@prisma/client";

// 整个后端共用一个 PrismaClient 实例，避免重复创建连接池。
export const prisma = new PrismaClient();
