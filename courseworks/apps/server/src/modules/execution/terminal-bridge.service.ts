/**
 * Streams interactive Lab terminal input and output over one authenticated WebSocket.
 * HTTP terminal endpoints remain available as a compatibility fallback.
 */
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

import { prisma } from "../../infrastructure/prisma/client.js";
import { verifyToken } from "../identity/index.js";
import {
  getQemuSessionSnapshot,
  resizeWorkspaceShell,
  sendQemuSessionInput,
  subscribeQemuSession,
  workspaceOwnsInteractiveSession,
} from "./qemu-session.service.js";

const MAX_INPUT_BYTES = 64 * 1024;

type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; columns: number; rows: number };

function sendJson(webSocket: WebSocket, value: unknown) {
  if (webSocket.readyState === WebSocket.OPEN) {
    webSocket.send(JSON.stringify(value));
  }
}

export function attachTerminalBridge(server: Server) {
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_INPUT_BYTES });

  server.on("upgrade", async (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/api/workspace/lab/terminal") return;

    try {
      const token = url.searchParams.get("token");
      if (!token) throw new Error("Missing token.");
      const payload = verifyToken(token);
      if (!["student", "teacher"].includes(payload.role)) throw new Error("Forbidden.");

      const workspace = await prisma.workspace.findUnique({ where: { userId: payload.sub } });
      const sessionId = url.searchParams.get("sessionId");
      if (!workspace || !sessionId || !workspaceOwnsInteractiveSession(workspace.id, sessionId)) {
        throw new Error("Interactive session not found.");
      }

      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        const unsubscribe = subscribeQemuSession(sessionId, (event) => sendJson(webSocket, event));
        sendJson(webSocket, { type: "snapshot", session: getQemuSessionSnapshot(sessionId) });

        webSocket.on("message", (raw) => {
          try {
            const message = JSON.parse(raw.toString()) as TerminalClientMessage;
            if (message.type === "input" && typeof message.data === "string") {
              if (Buffer.byteLength(message.data) > MAX_INPUT_BYTES) throw new Error("Terminal input is too large.");
              sendQemuSessionInput(sessionId, message.data);
              return;
            }
            if (
              message.type === "resize"
              && Number.isInteger(message.columns)
              && Number.isInteger(message.rows)
              && message.columns >= 20
              && message.columns <= 500
              && message.rows >= 5
              && message.rows <= 200
            ) {
              void resizeWorkspaceShell(sessionId, message.columns, message.rows)
                .then(() => sendJson(webSocket, {
                  type: "resized",
                  columns: message.columns,
                  rows: message.rows,
                }))
                .catch((error) => {
                  sendJson(webSocket, {
                    type: "error",
                    message: error instanceof Error ? error.message : "Unable to resize workspace terminal.",
                  });
                });
              return;
            }
            throw new Error("Invalid terminal message.");
          } catch (error) {
            sendJson(webSocket, {
              type: "error",
              message: error instanceof Error ? error.message : "Terminal request failed.",
            });
          }
        });
        webSocket.on("close", unsubscribe);
        webSocket.on("error", unsubscribe);
      });
    } catch {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });
}
