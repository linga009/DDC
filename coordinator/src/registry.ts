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
  private readonly nodes = new Map<string, StoredNode>();

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
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
    node.lastSeen = this.clock();
    return true;
  }

  listActive(timeoutMs = 30000): NodeInfo[] {
    const now = this.clock();
    const active: NodeInfo[] = [];
    for (const [nodeId, node] of this.nodes) {
      if (now - node.lastSeen <= timeoutMs) {
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
