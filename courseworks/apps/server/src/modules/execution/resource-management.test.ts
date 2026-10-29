import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { config } from "../../config/index.js";
import { getContainerRunProfile } from "./container-run-profile.js";
import { containerResourceMonitorTestSupport as monitor, registerManagedContainer, unregisterManagedContainer, managedContainerSnapshot, noteContainerOutput, stopContainerResourceMonitor } from "./container-resource-monitor.service.js";
import { acquireExecutionAdmission, tryAcquireExecutionAdmission, executionAdmissionSnapshot, executionAdmissionTestSupport as admission } from "./execution-admission.service.js";
import { resourceIds } from "./resource-telemetry.js";
import { removeManagedContainer, isContainerRemovalPending, containerCleanupTestSupport as cleanup } from "./container-cleanup.js";

afterEach(() => { monitor.reset(); admission.reset(); cleanup.reset(); });

test("admin container snapshot exposes allocation and ownership without private metadata", () => {
  const profile = getContainerRunProfile("shell");
  registerManagedContainer({containerName:"monitor-test",profile,metadata:{workspaceId:"workspace-test",workspacePath:"/private/student/path",secret:"not-for-monitor"},onLimit:()=>{}});
  stopContainerResourceMonitor();
  const snapshot=managedContainerSnapshot();
  assert.equal(snapshot.length,1);
  assert.equal(snapshot[0]?.workspaceId,"workspace-test");
  assert.equal(snapshot[0]?.cpuLimit,profile.cpus);
  assert.equal(snapshot[0]?.memoryLimitBytes,profile.memoryBytes);
  assert.ok(!JSON.stringify(snapshot).includes("private"));
  assert.ok(!JSON.stringify(snapshot).includes("not-for-monitor"));
  unregisterManagedContainer("monitor-test");
  assert.deepEqual(managedContainerSnapshot(),[]);
});

test("cleanup deduplicates removal and retains admission until confirmed gone", async () => {
  let resolve!: (s: string) => void;
  cleanup.setDocker(() => new Promise((done) => { resolve = done; }));
  const lease = await acquireExecutionAdmission({ profiles: [getContainerRunProfile("shell")] });
  const removal = removeManagedContainer("shell-test");
  const release = removal.then(() => lease.release());
  assert.equal(removeManagedContainer("shell-test"), removal);
  assert.equal(isContainerRemovalPending("shell-test"), true);
  assert.equal(executionAdmissionSnapshot().active, 1);
  resolve("");
  await release;
  assert.equal(executionAdmissionSnapshot().active, 0);
  assert.equal(isContainerRemovalPending("shell-test"), false);
});

test("failed cleanup is retried rather than treated as a released resource", async () => {
  let attempts = 0;
  cleanup.setDocker(async (args) => {
    if (args[0] === "ps") return "still-present";
    attempts++;
    if (attempts === 1) throw new Error("namespace still in use");
    return "";
  });
  await removeManagedContainer("retry-test");
  assert.equal(attempts, 2);
});

test("cancellation before Docker create finishes waits and removes the late container", async () => {
  let attempts = 0;
  cleanup.setDocker(async (args) => {
    if (args[0] === "ps") return "";
    attempts++;
    if (attempts === 1) throw new Error("not created yet");
    return "late-container-removed";
  });
  await removeManagedContainer("late-test", true);
  assert.equal(attempts, 2);
});

test("docker rm -f exit zero for absent name does not end creation grace", async () => {
  let attempts = 0;
  cleanup.setDocker(async (args) => {
    if (args[0] === "ps") return "";
    return ++attempts === 1 ? "" : "late-container-removed";
  });
  await removeManagedContainer("late-zero-test", true);
  assert.equal(attempts, 2);
});

test("all idle shells expire even while Docker sampling is stalled", async () => {
  const reasons: string[] = [];
  for (const name of ["shell-a", "shell-b"]) registerManagedContainer({ containerName: name, profile: getContainerRunProfile("shell"), onLimit: (reason) => reasons.push(reason) });
  stopContainerResourceMonitor();
  let resume!: (s: string) => void;
  monitor.setDocker((args) => args[0] === "ps" ? new Promise((resolve) => { resume = resolve; }) : Promise.resolve(""));
  const sampling = monitor.sample();
  // host sampling happens before Docker, so allow its asynchronous reads to finish.
  while (!resume) await new Promise((resolve) => setTimeout(resolve, 5));
  monitor.enforceDeadlines(Date.now() + config.EXECUTION_SHELL_IDLE_TIMEOUT_MS + 1);
  assert.deepEqual(reasons, ["idle_timeout", "idle_timeout"]);
  assert.equal(monitor.size(), 0);
  resume("");
  await sampling;
});

test("stats uses explicit managed names; busy CPU and memory do not kill valid work", async () => {
  let terminated = false;
  const calls: string[][] = [];
  registerManagedContainer({ containerName: "busy", profile: getContainerRunProfile("agent-bash"), onLimit: () => { terminated = true; } });
  stopContainerResourceMonitor();
  monitor.setDocker(async (args) => {
    calls.push(args);
    if (args[0] === "ps") return "busy\n";
    return JSON.stringify({ Name: "busy", CPUPerc: "100%", MemUsage: "767MiB / 768MiB", PIDs: "127" });
  });
  await monitor.sample();
  assert.deepEqual(calls[1], ["stats", "--no-stream", "--format", "{{json .}}", "busy"]);
  assert.equal(terminated, false);
  assert.equal(monitor.memoryUsage("1.5GiB / 2GiB"), 1.5 * 1024 ** 3);
});

test("no registered containers never invokes unfiltered docker stats", async () => {
  const calls: string[][] = [];
  monitor.setDocker(async (args) => { calls.push(args); return ""; });
  await monitor.sample();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "ps");
});

test("Docker errors are contained and subsequent samples recover", async () => {
  monitor.setDocker(async () => { throw new Error("offline"); });
  await monitor.sample();
  let called = false;
  monitor.setDocker(async () => { called = true; return ""; });
  await monitor.sample();
  assert.equal(called, true);
});

test("orphan cleanup waits for grace and retries failures without blocking other orphans", async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  const removals: string[] = [];
  let fail = true;
  monitor.setDocker(async (args) => {
    if (args[0] === "ps") return "orphan-a\norphan-b\n";
    removals.push(args[2]);
    if (args[2] === "orphan-a" && fail) throw new Error("retry");
    return "";
  });
  try {
    await monitor.sample();
    assert.deepEqual(removals, []);
    now += 60001;
    await monitor.sample();
    assert.deepEqual(removals, ["orphan-a", "orphan-b"]);
    fail = false;
    await monitor.sample();
    assert.deepEqual(removals, ["orphan-a", "orphan-b", "orphan-a"]);
  } finally { Date.now = originalNow; }
});

test("output flood terminates once and IDs exclude user content", () => {
  let terminations = 0;
  monitor.setDocker(async () => "");
  registerManagedContainer({ containerName: "flood", profile: getContainerRunProfile("shell"), onLimit: () => { terminations += 1; } });
  const bytes = config.EXECUTION_OUTPUT_RATE_BYTES_PER_SEC * config.EXECUTION_OUTPUT_RATE_DURATION_MS / 1000 + 1;
  noteContainerOutput("flood", bytes);
  noteContainerOutput("flood", bytes);
  assert.equal(terminations, 1);
  assert.deepEqual(resourceIds({ workspaceId: "w", command: "secret", workspacePath: "/private", apiKey: "secret" }), { workspaceId: "w", runId: undefined, sessionId: undefined, userId: undefined });
});

test("cancelled queued tools cannot later consume a lease", async () => {
  const request = { profiles: [getContainerRunProfile("agent-bash")], workspaceId: "same-workspace" };
  const lease = tryAcquireExecutionAdmission(request)!;
  assert.ok(lease);
  const controller = new AbortController();
  const pending = acquireExecutionAdmission({ ...request, signal: controller.signal });
  assert.equal(executionAdmissionSnapshot().waiting, 1);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  lease.release();
  assert.equal(executionAdmissionSnapshot().waiting, 0);
  assert.equal(executionAdmissionSnapshot().active, 0);
});

test("releasing a heavy task admits queued work and double release is harmless", async () => {
  const request = { profiles: [getContainerRunProfile("agent-bash")], workspaceId: "same-workspace" };
  const first = await acquireExecutionAdmission(request);
  const pending = acquireExecutionAdmission(request);
  first.release();
  first.release();
  const second = await pending;
  assert.equal(executionAdmissionSnapshot().active, 1);
  second.release();
  assert.equal(executionAdmissionSnapshot().active, 0);
});
