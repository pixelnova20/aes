import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resourceEvent } from "./resource-telemetry.js";

const exec = promisify(execFile);
const pending = new Map<string, Promise<void>>();
async function realDocker(args: string[]) {
  return (await exec("docker", args, { timeout: 10000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 })).stdout;
}
let docker = realDocker;

// A failed removal must retain its lease. Reconcile until Docker confirms absence.
export function removeManagedContainer(containerName: string, waitForCreation = false): Promise<void> {
  const existing = pending.get(containerName);
  if (existing) return existing;
  const startedAt = Date.now();
  const removal = (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const removed = await docker(["rm", "-f", containerName]);
        // Docker can return exit 0 with empty stdout for an absent name with -f.
        if (waitForCreation && !removed.trim() && Date.now() - startedAt < 30000) {
          throw Object.assign(new Error("Waiting for an in-flight create request."), { code: "CREATE_PENDING" });
        }
        break;
      } catch (error) {
        const absent = await docker(["ps", "-aq", "--filter", `name=^/${containerName}$`]).then((s) => !s.trim()).catch(() => false);
        // Killing the CLI cannot cancel a create request already accepted by dockerd.
        if (absent && (!waitForCreation || Date.now() - startedAt >= 30000)) break;
        resourceEvent("container_cleanup_retry", { containerName, attempt, code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN" });
        await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 1000, 10000)));
      }
    }
    resourceEvent("container_removed", { containerName, cleanupDurationMs: Date.now() - startedAt });
  })().finally(() => { pending.delete(containerName); });
  pending.set(containerName, removal);
  return removal;
}

export function isContainerRemovalPending(containerName: string) { return pending.has(containerName); }

export const containerCleanupTestSupport = {
  setDocker(fn: typeof realDocker) { docker = fn; },
  reset() { docker = realDocker; },
};
