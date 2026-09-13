import { createHash } from "node:crypto";
import type { ReputationTracker } from "./reputation_tracker.ts";

export type DeviceTier = "desktop" | "android" | "ios";

export const UNGROUPED_LOCALITY = "ungrouped";

export interface NodeInfo {
  nodeId: string;
  endpoint: string;
  deviceTier: DeviceTier;
  localityGroup?: string;
  servesModel?: string;
  // Self-reported, unverified -- exactly like deviceTier/localityGroup/
  // servesModel above (this project's established posture: self-reported
  // fields answer "who may talk to the service", never "is what they
  // claim true"). Used only as a soft preference when picking a pipeline
  // driver (coordinator/src/pipeline_selector.ts), never a hard gate.
  availableMemoryMb?: number;
}

interface StoredNode extends NodeInfo {
  lastSeen: number;
}

// `identityKey` must already be a CANONICAL identity key (see
// endpoint_identity.ts's canonicalizeEndpoint()), not a raw endpoint
// string. This function itself does no canonicalization -- every caller is
// responsible for canonicalizing first, per the Endpoint Identity
// Hardening design's separation of "compute the identity" (async, DNS
// involved) from "derive the id from it" (sync, pure hashing).
//
// Deterministic, not random: the same identity key must always produce the
// same nodeId, no matter how many times or how far apart in time it
// registers. This is what makes a re-registration below overwrite (not
// duplicate) the existing Map entry, closing the "re-register to clear
// reputation" and "go quiet 30s then reset" evasions -- identity here
// never depends on any prior entry still being present in `nodes`, unlike
// a live scan for a matching endpoint (PeerRegistry's approach) would.
//
// Before Endpoint Identity Hardening this hashed the raw (lowercased)
// endpoint string directly, which meant 127.0.0.1/localhost/[::1]/a
// trailing-dot FQDN pointed at the same machine each got their own clean
// identity for free -- the gap this whole phase closes. See
// canonicalizeEndpoint() for how the key passed in here collapses those
// aliases to one string first.
export function stableNodeId(identityKey: string): string {
  return createHash("sha256").update(identityKey).digest("hex");
}

export class NodeRegistry {
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly nodes = new Map<string, StoredNode>();

  constructor(clock: () => number = Date.now, timeoutMs = 30000) {
    this.clock = clock;
    this.timeoutMs = timeoutMs;
  }

  // `identityKey` is the CANONICAL identity (see stableNodeId()'s own
  // comment) -- the caller has already resolved/canonicalized `endpoint`
  // before calling this. `endpoint` itself stays the exact contact URL:
  // POST /generate fetches `${node.endpoint}/complete` verbatim, and
  // substituting a resolved IP here would break TLS SNI and name-based
  // virtual hosting for an https endpoint.
  //
  // Whole-branch review finding, Critical, fixed here: before Endpoint
  // Identity Hardening, the only way to collide with an existing nodeId
  // was to submit the exact same (lowercased) endpoint STRING, so
  // overwriting `endpoint` with a value identical to what it already held
  // was a no-op by construction -- Security Phase 3 never had to think
  // about this. Canonicalization widened what counts as a collision
  // (aliases, and any two endpoints an attacker can make resolve
  // together) without this method also being taught that a DIFFERENT
  // endpoint string can now legitimately collide. Live-verified before
  // this fix: registering a DNS name an attacker controls that resolves
  // to a trusted node's IP -- or simply a different loopback address, if
  // the loopback range collapsed as broadly as canonicalizeEndpoint()
  // used to -- silently overwrote the victim's `endpoint`, redirecting
  // every future /generate call for that identity to the attacker, who
  // could then repoint DNS at will with zero further coordinator
  // interaction. verifyNodeIdentity() genuinely contacts the machine
  // behind the SUBMITTED endpoint and gets truthful fields back from it --
  // that was never the gap. The gap was that "truthful fields from
  // whoever answered" was then used to justify overwriting WHERE FUTURE
  // REQUESTS GO, which is a different and stronger claim than anything the
  // callback actually establishes.
  //
  // The fix matches the pattern LauncherRegistry.register() and
  // PeerRegistry.register() already established (their own refresh
  // branches never touch `endpoint` either) instead of inventing a new
  // rule: while an ACTIVE entry already exists for this identity, its
  // endpoint is never replaced by a colliding registration, no matter what
  // that registration claims or how its own /identity call resolved.
  // deviceTier/servesModel still refresh from the newly-verified answer
  // (harmless even under attack, since verifyNodeIdentity() always
  // contacts whoever is really listening at the identity's stable
  // endpoint once one exists) -- only the contact URL itself is pinned.
  // localityGroup/availableMemoryMb remain exactly as disclosed already
  // (Security Phase 3): still overwritable by anyone who can trigger a
  // collision, now reachable via alias/DNS collision and not only an
  // exact endpoint-string match -- see README.
  //
  // An EXPIRED existing entry does not pin anything: that is the
  // legitimate "this identity's node moved / came back under a new
  // address" case, and it free-forms exactly like a first-time
  // registration once the old entry has aged out.
  register(endpoint: string, identityKey: string, deviceTier: DeviceTier, localityGroup?: string, servesModel?: string, availableMemoryMb?: number): string {
    const nodeId = stableNodeId(identityKey);
    const now = this.clock();
    const existing = this.nodes.get(nodeId);
    const existingIsActive = existing !== undefined && now - existing.lastSeen <= this.timeoutMs;
    const resolvedEndpoint = existingIsActive ? existing.endpoint : endpoint;
    this.nodes.set(nodeId, { nodeId, endpoint: resolvedEndpoint, deviceTier, localityGroup, servesModel, availableMemoryMb, lastSeen: now });
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
        active.push({ nodeId: node.nodeId, endpoint: node.endpoint, deviceTier: node.deviceTier, localityGroup: node.localityGroup, servesModel: node.servesModel, availableMemoryMb: node.availableMemoryMb });
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
