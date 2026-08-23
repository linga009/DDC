import { randomUUID } from "node:crypto";

export interface LauncherInfo {
  launcherId: string;
  endpoint: string;
  servesModels: string[];
  agentPort: number;
}

interface StoredLauncher extends LauncherInfo {
  lastSeen: number;
}

const DEFAULT_TIMEOUT_MS = 30000;

// Mirrors coordinator/src/peer_registry.ts's shape almost exactly (the
// closest existing precedent for "an external service the coordinator
// talks to, discovered via its own registration rather than the
// NodeRegistry's node-identity mechanism") -- see this plan's design doc,
// Architecture #2b, for why a launcher needs its own registry rather than
// reusing NodeRegistry (nothing has been spawned yet at registration time,
// so there's no /complete-serving endpoint to register as a NodeInfo).
export class LauncherRegistry {
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly launchers = new Map<string, StoredLauncher>();

  constructor(clock: () => number = Date.now, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.clock = clock;
    this.timeoutMs = timeoutMs;
  }

  register(endpoint: string, servesModels: string[], agentPort: number): string {
    const now = this.clock();
    for (const [launcherId, launcher] of this.launchers) {
      if (now - launcher.lastSeen > this.timeoutMs) {
        this.launchers.delete(launcherId);
        continue;
      }
      if (launcher.endpoint === endpoint) {
        // Refresh in place rather than minting a duplicate entry for the
        // same endpoint -- also picks up an updated servesModels/agentPort
        // if the operator restarted the launcher with different flags.
        launcher.servesModels = servesModels;
        launcher.agentPort = agentPort;
        launcher.lastSeen = now;
        return launcher.launcherId;
      }
    }
    const launcherId = randomUUID();
    this.launchers.set(launcherId, { launcherId, endpoint, servesModels, agentPort, lastSeen: now });
    return launcherId;
  }

  heartbeat(launcherId: string): boolean {
    const launcher = this.launchers.get(launcherId);
    if (!launcher) {
      return false;
    }
    const now = this.clock();
    if (now - launcher.lastSeen > this.timeoutMs) {
      this.launchers.delete(launcherId);
      return false;
    }
    launcher.lastSeen = now;
    return true;
  }

  listActive(): LauncherInfo[] {
    const now = this.clock();
    const active: LauncherInfo[] = [];
    for (const [launcherId, launcher] of this.launchers) {
      if (now - launcher.lastSeen <= this.timeoutMs) {
        active.push({ launcherId: launcher.launcherId, endpoint: launcher.endpoint, servesModels: launcher.servesModels, agentPort: launcher.agentPort });
      } else {
        this.launchers.delete(launcherId);
      }
    }
    return active;
  }

  findForModel(modelId: string): LauncherInfo | undefined {
    return this.listActive().find(launcher => launcher.servesModels.includes(modelId));
  }
}
