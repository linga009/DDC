import { randomUUID } from "node:crypto";

export interface PeerInfo {
  peerId: string;
  endpoint: string;
}

interface StoredPeer extends PeerInfo {
  lastSeen: number;
}

const DEFAULT_TIMEOUT_MS = 30000;

export class PeerRegistry {
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly peers = new Map<string, StoredPeer>();

  constructor(clock: () => number = Date.now, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.clock = clock;
    this.timeoutMs = timeoutMs;
  }

  register(endpoint: string): string {
    for (const peer of this.peers.values()) {
      if (peer.endpoint === endpoint) {
        // Already registered -- treat this as a refresh (same effect as a
        // heartbeat) rather than minting a duplicate entry for the same
        // endpoint, which would otherwise double-count that peer's reported
        // capacity in the federated aggregate.
        peer.lastSeen = this.clock();
        return peer.peerId;
      }
    }
    const peerId = randomUUID();
    this.peers.set(peerId, { peerId, endpoint, lastSeen: this.clock() });
    return peerId;
  }

  heartbeat(peerId: string): boolean {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return false;
    }
    const now = this.clock();
    if (now - peer.lastSeen > this.timeoutMs) {
      // Already past the timeout -- treat this like an unknown peer rather
      // than reviving it. Otherwise heartbeat's result for a stale peer
      // would depend on whether some unrelated listActive() call happened
      // to have scanned-and-pruned it first, which is a nondeterministic
      // contract driven entirely by incidental traffic. Past-timeout now
      // unconditionally means heartbeat() returns false.
      this.peers.delete(peerId);
      return false;
    }
    peer.lastSeen = now;
    return true;
  }

  deregister(peerId: string): boolean {
    return this.peers.delete(peerId);
  }

  listActive(): PeerInfo[] {
    const now = this.clock();
    const active: PeerInfo[] = [];
    for (const [peerId, peer] of this.peers) {
      if (now - peer.lastSeen <= this.timeoutMs) {
        active.push({ peerId: peer.peerId, endpoint: peer.endpoint });
      } else {
        // Expired -- prune it here rather than just leaving it out of the
        // result, so long-running processes don't accumulate dead entries.
        this.peers.delete(peerId);
      }
    }
    return active;
  }
}
