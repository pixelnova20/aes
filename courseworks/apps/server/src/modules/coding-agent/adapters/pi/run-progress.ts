import { createHash } from "node:crypto";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export function isModelProgress(event: AgentSessionEvent) {
  if (event.type !== "message_update") return false;
  const update = event.assistantMessageEvent;
  return "delta" in update && typeof update.delta === "string" && update.delta.length > 0;
}

/** Activity extends the idle lease; repeated tool outcomes are checked independently. */
export class RunProgress {
  lastActivity: number;
  repeated = 0;
  private readonly calls = new Map<string, string>();
  private readonly outcomes = new Set<string>();
  constructor(private readonly idleMs: number, private readonly repeatLimit: number, now: number) {
    this.lastActivity = now;
  }
  observe(event: AgentSessionEvent, now: number) {
    if (isModelProgress(event)) this.lastActivity = now;
    if (event.type === "tool_execution_start") {
      this.calls.set(event.toolCallId, JSON.stringify([event.toolName, event.args]));
    }
    if (event.type === "tool_execution_end") {
      this.lastActivity = now;
      const call = this.calls.get(event.toolCallId);
      this.calls.delete(event.toolCallId);
      if (call === undefined) return;
      const result = event.result as { content?: unknown } | undefined;
      const fingerprint = createHash("sha256").update(JSON.stringify([call, event.isError, result?.content ?? event.result])).digest("hex");
      if (this.outcomes.has(fingerprint)) this.repeated++;
      else {
        this.repeated = 0;
        this.outcomes.add(fingerprint);
        if (this.outcomes.size > 128) this.outcomes.delete(this.outcomes.values().next().value!);
      }
    }
  }
  reason(now: number) {
    if (this.repeated >= this.repeatLimit) return "repeated_tool_results";
    if (now - this.lastActivity >= this.idleMs) return "idle_timeout";
    return undefined;
  }
  warning(now: number) {
    return this.repeated >= Math.ceil(this.repeatLimit / 2) || now - this.lastActivity >= this.idleMs * 0.8;
  }
}
