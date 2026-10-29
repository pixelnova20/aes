import { createEventLogger } from "@aes/management";
import type { RequestHandler } from "express";

export const authEvents = createEventLogger("courseworks", "auth");
const operations = createEventLogger("courseworks", "operations");

export const requestAudit: RequestHandler = (request, response, next) => {
  const started = performance.now();
  response.once("finish", () => {
    if (request.path === "/api/health") return;
    operations.write("http_request", {
      method: request.method,
      route: request.route?.path ?? "<unmatched>",
      module: request.originalUrl.split("?")[0].split("/")[2],
      userId: request.auth?.userId,
      role: request.auth?.role,
      status: response.statusCode,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    });
  });
  next();
};
