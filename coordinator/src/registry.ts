import { randomUUID } from "node:crypto";

export type DeviceTier = "desktop" | "android" | "ios";

export interface NodeInfo {
  nodeId: string;
  endpoint: string;
  deviceTier: DeviceTier;
}

interface StoredNode extends NodeInfo {
  lastSeen: number;
}

export class NodeRegistry {
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly nodes = new Map<string, StoredNode>();

  constructor(clock: () => number = Date.now, timeoutMs = 30000) {
    this.clock = clock;
    this.timeoutMs = timeoutMs;
  }

  register(endpoint: string, deviceTier: DeviceTier): string {
    const nodeId = randomUUID();
    this.nodes.set(nodeId, { nodeId, endpoint, deviceTier, lastSeen: this.clock() });
    return nodeId;
  }

  heartbeat(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) {
      return false;
    }
    const now = this.clock();
    if (now - node.lastSeen > this.timeoutMs) {
      // Already past the timeout -- treat this like an unknown node rather
      // than reviving it. Otherwise heartbeat's result for a stale node
      // would depend on whether some unrelated listActive() call happened
      // to have scanned-and-pruned it first, which is a nondeterministic
      // contract driven entirely by incidental traffic. Past-timeout now
      // unconditionally means heartbeat() returns false.
      this.nodes.delete(nodeId);
      return false;
    }
    node.lastSeen = now;
    return true;
  }

  listActive(): NodeInfo[] {
    const now = this.clock();
    const active: NodeInfo[] = [];
    for (const [nodeId, node] of this.nodes) {
      if (now - node.lastSeen <= this.timeoutMs) {
        active.push({ nodeId: node.nodeId, endpoint: node.endpoint, deviceTier: node.deviceTier });
      } else {
        // Expired -- prune it here rather than just leaving it out of the
        // result, so long-running processes don't accumulate dead entries.
        this.nodes.delete(nodeId);
      }
    }
    return active;
  }

  size(): number {
    return this.nodes.size;
  }
}
