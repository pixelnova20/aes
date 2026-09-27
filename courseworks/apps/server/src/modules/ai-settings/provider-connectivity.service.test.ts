/** Tests backend-host Provider model discovery and connection checks. */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { buildProviderTestRequest } from "./model-capability.service.js";
import { listAiProviderModels, parseAiProviderModels, testAiProvider } from "./provider-connectivity.service.js";

test("parses and sorts common OpenAI-compatible model lists", () => {
  assert.deepEqual(
    parseAiProviderModels(JSON.stringify({
      data: [
        { id: "GLM-5.2" },
        { name: "DeepSeek-V4-Pro" },
        { model: "gpt-oss:120b" },
        { id: "GLM-5.2" },
      ],
    })),
    ["DeepSeek-V4-Pro", "GLM-5.2", "gpt-oss:120b"],
  );
  assert.deepEqual(
    parseAiProviderModels(JSON.stringify({ models: ["model-b", { id: "model-a" }] })),
    ["model-a", "model-b"],
  );
});

test("discovers models and tests chat directly from the backend process", async (context) => {
  const requests: Array<{ method?: string; url?: string; authorization?: string; body?: string }> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body });
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/v1/models") {
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }));
        return;
      }
      response.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  assert.deepEqual(await listAiProviderModels({ baseUrl, apiKey: "test-key" }), ["gpt-5.6-sol"]);
  assert.deepEqual(
    await testAiProvider({ baseUrl, apiKey: "test-key", model: "gpt-5.6-sol", reasoningEffort: "max" }),
    { message: "Courseworks 后端连接成功。" },
  );
  assert.deepEqual(requests, [
    { method: "GET", url: "/v1/models", authorization: "Bearer test-key", body: "" },
    {
      method: "POST",
      url: "/v1/chat/completions",
      authorization: "Bearer test-key",
      body: JSON.stringify(buildProviderTestRequest("gpt-5.6-sol", "max")),
    },
  ]);
});
