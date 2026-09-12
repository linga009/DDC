export type PooledPipelineState = "warm" | "assembling" | "failed";

export interface PooledPipeline {
  pipelineId: string;
  driverNodeId: string;
  computeNodeIds: string[];
  launcherId: string;
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
