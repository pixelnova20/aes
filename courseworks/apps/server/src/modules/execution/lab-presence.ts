import { resourceEvent } from "./resource-telemetry.js";

/** Page-level ownership keeps background Bash tabs alive without streaming their output. */
export class LabPresence {
  private readonly workspaces = new Map<string, { clients: Set<symbol>; timer?: ReturnType<typeof setTimeout> }>();

  constructor(private readonly expire: (workspaceId: string) => void, private readonly graceMs = 60_000) {}

  track(workspaceId: string) {
    const state = this.workspaces.get(workspaceId) ?? { clients: new Set<symbol>() };
    this.workspaces.set(workspaceId, state);
    if (state.clients.size || state.timer) return;
    resourceEvent("lab_disconnect_pending", { workspaceId, graceMs: this.graceMs });
    state.timer = setTimeout(() => {
      if (this.workspaces.get(workspaceId) !== state || state.clients.size) return;
      this.workspaces.delete(workspaceId);
      resourceEvent("lab_disconnect_expired", { workspaceId });
      this.expire(workspaceId);
    }, this.graceMs);
    state.timer.unref();
  }

  connect(workspaceId: string) {
    const state = this.workspaces.get(workspaceId) ?? { clients: new Set<symbol>() };
    const client = Symbol();
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    state.clients.add(client);
    this.workspaces.set(workspaceId, state);
    resourceEvent("lab_connected", { workspaceId, connections: state.clients.size });
    return (explicitExit = false) => {
      if (!state.clients.delete(client)) return;
      resourceEvent("lab_disconnected", { workspaceId, connections: state.clients.size, explicitExit });
      if (state.clients.size) return;
      if (explicitExit) {
        this.workspaces.delete(workspaceId);
        resourceEvent("lab_explicit_exit", { workspaceId });
        this.expire(workspaceId);
      } else this.track(workspaceId);
    };
  }
}
