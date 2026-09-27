/**
 * 文件作用：提供后端进程装配层所需的声明和装配。
 * 模块位置：`apps/server/src/app/server.ts`，属于后端进程装配层。
 * 重要函数：本文件以类型、常量、导出装配或启动副作用为主，不包含独立具名函数。
 */
import { createServer } from "node:http";

import { app } from "./app.js";
import { ensureConfiguredSuperuser } from "../application/identity/account-application.service.js";
import { config } from "../config/index.js";
import { initLogFile, logSystem, isLogViewerEnabled } from "../infrastructure/logging/logger.js";
import { prisma } from "../infrastructure/prisma/client.js";
import {
  attachTerminalBridge,
  attachVncBridge,
  cleanupStaleWorkspaceRuntimes,
  startContainerResourceMonitor,
} from "../modules/execution/index.js";
import { syncWorkspaceMatchFile } from "../modules/workspaces/index.js";

async function startServer() {
  await ensureConfiguredSuperuser();

  // 初始化调试日志（仅在 LOG_VIEWER_ENABLED=true 时生效）
  initLogFile(config.WORKSPACE_ROOT);

  // server.ts 负责真正启动 HTTP Server，并补上需要直接绑定到
  // Node Server 的能力，例如 VNC WebSocket 桥接。
  const server = createServer(app);
  cleanupStaleWorkspaceRuntimes();
  startContainerResourceMonitor();

  syncWorkspaceMatchFile().catch((error) => {
    console.error("Unable to synchronize student workspace match.txt:", error);
  });

  await prisma.agentRun.updateMany({
    where: { finishedAt: null },
    data: { status: "cancelled", finishedAt: new Date() },
  }).then((result) => {
    if (result.count > 0) console.log(`Cancelled ${result.count} stale agent runs on startup.`);
  }).catch(() => {});
  await prisma.classAiTokenUsage.updateMany({
    where: { reservedTokens: { gt: 0 } },
    data: { reservedTokens: 0 },
  }).catch((error) => {
    console.error("Unable to release stale AI token reservations:", error);
  });
  attachVncBridge(server);
  attachTerminalBridge(server);

  server.listen(config.BACKEND_PORT, config.BACKEND_HOST, () => {
    const msg = `Backend listening on http://${config.BACKEND_HOST}:${config.BACKEND_PORT}`;
    console.log(msg);
    logSystem(msg);
    if (isLogViewerEnabled()) {
      console.log("Log viewer enabled -> http://<host>:9090");
    }
  });
}

startServer().catch((error) => {
  console.error("Backend startup failed.");
  console.error(error);
  process.exitCode = 1;
});
