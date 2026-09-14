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
  // Self-reported, unverified -- like localityGroup above, but NOT like
  // deviceTier/servesModel anymore: Endpoint Identity Hardening made those
  // two endpoint-verified (server.ts's POST /nodes/register calls the
  // endpoint's own POST /identity and stores what it reports), while
  // localityGroup and this field were deliberately left caller-supplied
  // (the design doc's own per-field table -- neither has an analogous
  // "ask the endpoint" verification the way "what model do you serve"
  // does). Used only as a soft preference when picking a pipeline driver
  // (coordinator/src/pipeline_selector.ts), never a hard gate.
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
  // Before Endpoint Identity Hardening, the only way to collide with an
  // existing nodeId was to submit the exact same (lowercased) endpoint
  // STRING, so overwriting `endpoint` with a value identical to what it
  // already held was a no-op by construction -- Security Phase 3 never
  // had to think about this. Canonicalization widened what counts as a
  // collision (aliases, and any two endpoints an attacker can make
  // resolve together) without this method also being taught that a
  // DIFFERENT endpoint string can now legitimately collide.
  //
  // This pinning is defense-in-depth, not the primary defense. THREE
  // whole-branch review rounds are the reason for that split -- each one
  // found the previous round's fix had patched the location a symptom was
  // observed rather than the actual mechanism:
  // - Round 1 pinned `endpoint` here (this code) so a colliding
  //   registration could never overwrite it directly, matching the
  //   pattern LauncherRegistry.register()/PeerRegistry.register() already
  //   established (their own refresh branches never touch `endpoint`
  //   either).
  // - Round 2 found that pinning alone was not enough: server.ts's
  //   /nodes/register route still let a colliding registration reach
  //   verifyNodeIdentity() and this method at all. The fix: a registration
  //   whose endpoint does not match an already-ACTIVE entry for the same
  //   identity is rejected outright (409) BEFORE it ever reaches
  //   verifyNodeIdentity() or this method.
  // - Round 3 found that check itself had a TOCTOU gap -- it ran before
  //   `await verifyNodeIdentity()`, so a second, colliding registration
  //   could race through the same window and commit first. Fixed by
  //   re-checking synchronously, with no `await` between the re-check and
  //   register(), directly in the route handler -- see its comment.
  //   Round 3 also found this method's pinning ACTIVELY HARMFUL for one
  //   caller: the launcher-spawned internal driver registrations in
  //   server.ts's assemblePipeline() and pipeline_pool_manager.ts's
  //   tryAssemble() call this method directly, bypassing every one of the
  //   HTTP route's checks above -- and for THEM, the pinning below meant a
  //   squatter's earlier, unrelated registration silently kept its pinned
  //   endpoint instead of the driver's real one, live-verified to hand a
  //   real user's prompt to the squatter with a 200. Both call sites now
  //   guard themselves with pipeline_pool_manager.ts's
  //   assertDriverIdentityFree() immediately before calling register()
  //   here, refusing the assembly attempt outright on a collision instead
  //   of relying on (or being undermined by) this method's own pinning.
  //   This method's pinning below remains in place as a fallback for any
  //   future direct caller that does NOT have its own pre-commit check --
  //   it is not, and should not be assumed to be, sufficient on its own.
  //
  // localityGroup/availableMemoryMb remain exactly as disclosed already
  // (Security Phase 3): still overwritable by anyone who can trigger a
  // collision -- see README.
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
