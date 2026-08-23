export type PipelineState = "warm" | "failed";

export interface TrackedPipeline {
  driverNodeId?: string;
  computeNodeIds: string[];
  state: PipelineState;
}

// In-memory only, same as every other piece of coordinator state
// (NodeRegistry, PeerRegistry, ReputationTracker) -- a deliberate,
// disclosed limitation, not a gap. One tracked pipeline per model id,
// matching this plan's own Non-Goal (multiple concurrent pipelines per
// model is Phase C's problem, not this one's).
export class PipelineTracker {
  private readonly pipelines = new Map<string, TrackedPipeline>();

  get(modelId: string): TrackedPipeline | undefined {
    return this.pipelines.get(modelId);
  }

  markWarm(modelId: string, driverNodeId: string, computeNodeIds: string[]): void {
    this.pipelines.set(modelId, { driverNodeId, computeNodeIds, state: "warm" });
  }

  markFailed(modelId: string): void {
    this.pipelines.set(modelId, { driverNodeId: undefined, computeNodeIds: [], state: "failed" });
  }
}
