/**
 * 文件作用：实现后端“沙箱执行、构建与 QEMU”业务模块的核心操作。
 * 模块位置：`apps/server/src/modules/execution/vnc-bridge.service.ts`，属于后端“沙箱执行、构建与 QEMU”业务模块。
 * 重要函数：`attachVncBridge()` 负责挂接`vnc` `bridge`。
 */
import type { Server } from "node:http";
import net from "node:net";
import { WebSocket, WebSocketServer } from "ws";

import { prisma } from "../../infrastructure/prisma/client.js";
import { verifyToken } from "../identity/index.js";
import { getQemuVncTarget, workspaceOwnsInteractiveSession } from "./qemu-session.service.js";

/**
 * 功能：挂接`vnc` `bridge`。
 * 输入：`server`（Server）提供server。
 * 输出：返回该操作生成、查询或转换后的结果；异步实现以 Promise 交付结果。
 * 调用关系：由 `apps/server/src/app/server.ts 顶层流程` 调用；内部调用 `on()`、`verifyToken()`、`includes()`、`findUnique()`、`workspaceOwnsShell()`、`getQemuVncTarget()`。
 */
export function attachVncBridge(server: Server) {
  const webSockets = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/workspace/lab/vnc") return;

    let responseStatus = "401 Unauthorized";
    try {
      const token = url.searchParams.get("token");
      if (!token) throw new Error("Missing token.");
      const payload = verifyToken(token);
      if (!["student", "teacher"].includes(payload.role)) throw new Error("Forbidden.");

      const workspace = await prisma.workspace.findUnique({ where: { userId: payload.sub } });
      if (!workspace) throw new Error("Workspace not found.");
      const sessionId = url.searchParams.get("sessionId");
      responseStatus = "404 Not Found";
      if (!sessionId || !workspaceOwnsInteractiveSession(workspace.id, sessionId)) throw new Error("Session not found.");
      const target = getQemuVncTarget(sessionId);
      responseStatus = "503 Service Unavailable";
      if (!target) throw new Error("VNC bridge is not ready.");

      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        const tcp = net.createConnection(target);
        tcp.setNoDelay(true);
        tcp.setTimeout(2000);
        tcp.on("connect", () => tcp.setTimeout(0));
        tcp.on("timeout", () => {
          tcp.destroy();
          webSocket.close(1013, "Waiting for QEMU VNC.");
        });

        tcp.on("data", (data) => {
          if (webSocket.readyState === WebSocket.OPEN) webSocket.send(data);
        });
        webSocket.on("message", (data) => {
          if (!tcp.destroyed) tcp.write(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        });
        tcp.on("error", () => webSocket.close(1013, "VNC server is not ready."));
        webSocket.on("error", () => tcp.destroy());
        tcp.on("close", () => webSocket.close());
        webSocket.on("close", () => tcp.destroy());
      });
    } catch {
      socket.write(`HTTP/1.1 ${responseStatus}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    }
  });
}
