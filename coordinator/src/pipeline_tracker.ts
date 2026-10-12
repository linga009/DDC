export type PooledPipelineState = "warm" | "assembling" | "failed";

export interface PooledPipeline {
  pipelineId: string;
  driverNodeId: string;
  computeNodeIds: string[];
  launcherId: string;
  // The launcher's endpoint as it was at assembly time. Teardown needs it
  // because LauncherRegistry entries expire on their own heartbeat timeout:
  // if a launcher's registration lapses while its agent is still running,
  // looking the endpoint up by launcherId finds nothing and the DELETE is
  // silently skipped, freeing the launcherId while an orphan agent keeps
  // holding the port and the model's weights. Optional so entries built by
  // older code (and by tests) stay valid.
  launcherEndpoint?: string;
  // The launcher's CANONICAL identity key (see endpoint_identity.ts's
  // canonicalizeEndpoint()) as it was at assembly time -- kept alongside
  // launcherEndpoint above, not in place of it: this is what
  // claimedLauncherIds() tallies to recognise a launcher registered under
  // an alias as the same machine, while launcherEndpoint remains the
  // contact URL teardown actually calls DELETE on. Optional for the same
  // reason launcherEndpoint is.
  launcherIdentityKey?: string;
  // The endpoint this pipeline's driver was actually spawned on and
  // registered under (launcherDriverEndpoint()). Ninth whole-branch review:
  // an entry used to store only `driverNodeId`, which is a hash of the
  // driver's canonical IDENTITY, and every routing decision resolved it
  // through the registry's CURRENT binding for that id. Once the driver's
  // registration lapsed (any tick longer than the 30s node timeout does it),
  // a registration of the same identity under a different endpoint was
  // silently adopted by the still-"warm" entry -- and then kept alive by the
  // reaper's heartbeats -- so real prompts went to an endpoint this
  // coordinator never spawned. Routing, heartbeating and the liveness check
  // all require the registry's endpoint to still equal this one. Optional so
  // entries built by older code and by tests (which register a driver by
  // hand) stay valid; an entry without it keeps the old identity-only
  // behaviour.
  driverEndpoint?: string;
  // The CANONICAL identity key of the driver this entry's launcher spawns
  // (launcherDriverIdentityKey()), set on the reservation as well as on the
  // warm entry. POST /nodes/register refuses any identity a pool entry holds
  // -- not only those of ACTIVE launchers -- so a launcher whose own
  // registration lapsed mid-assembly cannot have its driver endpoint taken
  // over by a public registration in the meantime (ninth whole-branch review,
  // harness seed 51483: such a registration, at exactly the driver's endpoint
  // and so indistinguishable from the pool's own, revived a warm entry the
  // request path had just judged dead, while a replace-in-place spawn was
  // already queued to kill its agent).
  driverIdentityKey?: string;
  state: PooledPipelineState;
  lastUsedAt: number;
}

// In-memory only, same as every other piece of coordinator state
// (NodeRegistry, PeerRegistry, ReputationTracker, DemandTracker) -- a
// deliberate, disclosed limitation, not a gap. Multiple pool entries per
// model id are now supported (Phase C) -- Phase B's own single-slot
// version is gone, not kept alongside this one; every caller uses this
// pool-shaped API.
export class PipelineTracker {
  private readonly pools = new Map<string, PooledPipeline[]>();

  getPool(modelId: string): PooledPipeline[] {
    return this.pools.get(modelId) ?? [];
  }

  addEntry(modelId: string, entry: PooledPipeline): void {
    const pool = this.pools.get(modelId);
    if (pool) {
      pool.push(entry);
    } else {
      this.pools.set(modelId, [entry]);
    }
  }

  removeEntry(modelId: string, pipelineId: string): void {
    const pool = this.pools.get(modelId);
    if (!pool) {
      return;
    }
    const index = pool.findIndex(entry => entry.pipelineId === pipelineId);
    if (index !== -1) {
      pool.splice(index, 1);
    }
  }

  markEntryFailed(modelId: string, pipelineId: string): void {
    const pool = this.pools.get(modelId);
    const entry = pool?.find(e => e.pipelineId === pipelineId);
    if (entry) {
      entry.state = "failed";
    }
  }
}
