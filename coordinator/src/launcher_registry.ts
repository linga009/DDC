import { randomUUID } from "node:crypto";

export interface LauncherInfo {
  launcherId: string;
  endpoint: string;
  // Canonical identity key (see endpoint_identity.ts's canonicalizeEndpoint())
  // for the machine this launcher is reachable at -- distinct from
  // launcherId, which is a randomUUID re-minted whenever a lapsed
  // registration re-registers. Matching a re-registration on THIS instead
  // of raw endpoint equality is what recognises one physical launcher
  // registered under two aliases (127.0.0.1 vs localhost) as one machine,
  // rather than two, which was live-verified to let a second model claim
  // the "other" alias and receive the wrong model's weights.
  identityKey: string;
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

  // `identityKey` is the CANONICAL identity for `endpoint` -- the caller
  // has already resolved/canonicalized it before calling this, same
  // division of responsibility as NodeRegistry.register().
  register(endpoint: string, identityKey: string, servesModels: string[], agentPort: number): string {
    const now = this.clock();
    for (const [launcherId, launcher] of this.launchers) {
      if (now - launcher.lastSeen > this.timeoutMs) {
        this.launchers.delete(launcherId);
        continue;
      }
      if (launcher.identityKey === identityKey) {
        // Refresh in place rather than minting a duplicate entry for the
        // same machine -- also picks up an updated servesModels/agentPort
        // if the operator restarted the launcher with different flags.
        // Matching on identityKey (not raw endpoint equality) is what
        // recognises this launcher under an alias it registered under
        // before -- endpoint itself is intentionally left as whatever it
        // was first registered as, unchanged here, matching this
        // registry's existing behavior for servesModels/agentPort above.
        launcher.servesModels = servesModels;
        launcher.agentPort = agentPort;
        launcher.lastSeen = now;
        return launcher.launcherId;
      }
    }
    const launcherId = randomUUID();
    this.launchers.set(launcherId, { launcherId, endpoint, identityKey, servesModels, agentPort, lastSeen: now });
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
        active.push({ launcherId: launcher.launcherId, endpoint: launcher.endpoint, identityKey: launcher.identityKey, servesModels: launcher.servesModels, agentPort: launcher.agentPort });
      } else {
        this.launchers.delete(launcherId);
      }
    }
    return active;
  }

  findForModel(modelId: string): LauncherInfo | undefined {
    return this.listActive().find(launcher => launcher.servesModels.includes(modelId));
  }

  listForModel(modelId: string): LauncherInfo[] {
    return this.listActive().filter(launcher => launcher.servesModels.includes(modelId));
  }
}
