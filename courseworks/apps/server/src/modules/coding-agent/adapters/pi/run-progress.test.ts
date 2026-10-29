import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { RunProgress } from "./run-progress.js";
const event = (value: unknown) => value as AgentSessionEvent;
function tool(p: RunProgress, id: string, command: string, result: string, now: number) {
  p.observe(event({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command } }), now);
  p.observe(event({ type: "tool_execution_end", toolCallId: id, toolName: "bash", isError: false, result: { content: [{type:"text",text:result}] } }), now);
}
test("new output and completed tools permit runs longer than the idle lease", () => {
  const p=new RunProgress(600000,12,0);
  for(let n=1;n<=20;n++) {
    p.observe(event({type:"message_update",assistantMessageEvent:{type:"thinking_delta",delta:"thinking"}}), n*300000);
    assert.equal(p.reason(n*300000),undefined);
  }
  tool(p,"a","make","compiled",6300000);
  assert.equal(p.reason(6600000),undefined);
  assert.equal(p.reason(6900000),"idle_timeout");
});
test("heartbeat, empty deltas and tool output do not extend the idle lease", () => {
  const p=new RunProgress(100,12,0);
  p.observe(event({type:"message_update",assistantMessageEvent:{delta:""}}),90);
  p.observe(event({type:"tool_execution_update"}),90);
  assert.equal(p.warning(90),true);
  assert.equal(p.reason(100),"idle_timeout");
});
test("cycles of identical tool outcomes stop despite continuing model output", () => {
  const p=new RunProgress(1000,4,0);
  tool(p,"a","cat a","unchanged",1);tool(p,"b","cat b","unchanged",2);
  for(let n=0;n<4;n++){
    p.observe(event({type:"message_update",assistantMessageEvent:{delta:"retry"}}),3+n);
    tool(p,String(n),n%2?"cat b":"cat a","unchanged",3+n);
  }
  assert.equal(p.reason(7),"repeated_tool_results");
  tool(p,"new","cat a","changed",8);
  assert.equal(p.reason(8),undefined);
});
