import { randomUUID } from "node:crypto";
import type { ReputationTracker } from "./reputation_tracker.ts";

export type DeviceTier = "desktop" | "android" | "ios";

export const UNGROUPED_LOCALITY = "ungrouped";

export interface NodeInfo {
  nodeId: string;
  endpoint: string;
  deviceTier: DeviceTier;
  localityGroup?: string;
  servesModel?: string;
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

  register(endpoint: string, deviceTier: DeviceTier, localityGroup?: string, servesModel?: string): string {
    const nodeId = randomUUID();
    this.nodes.set(nodeId, { nodeId, endpoint, deviceTier, localityGroup, servesModel, lastSeen: this.clock() });
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

  listActive(reputation?: ReputationTracker): NodeInfo[] {
    const now = this.clock();
    const active: NodeInfo[] = [];
    for (const [nodeId, node] of this.nodes) {
      if (now - node.lastSeen <= this.timeoutMs) {
        if (reputation && !reputation.isTrusted(node.nodeId)) {
          continue;
        }
        active.push({ nodeId: node.nodeId, endpoint: node.endpoint, deviceTier: node.deviceTier, localityGroup: node.localityGroup, servesModel: node.servesModel });
      } else {
        // Expired -- prune it here rather than just leaving it out of the
        // result, so long-running processes don't accumulate dead entries.
        this.nodes.delete(nodeId);
      }
    }
    return active;
  }

  groupByLocality(reputation?: ReputationTracker): Map<string, NodeInfo[]> {
    const groups = new Map<string, NodeInfo[]>();
    for (const node of this.listActive(reputation)) {
      const key = node.localityGroup ?? UNGROUPED_LOCALITY;
      const bucket = groups.get(key);
      if (bucket) {
        bucket.push(node);
      } else {
        groups.set(key, [node]);
      }
    }
    return groups;
  }

  size(): number {
    return this.nodes.size;
  }
}
