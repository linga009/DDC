const WINDOW_MS = 60000;

// In-memory only, same as every other piece of coordinator state
// (NodeRegistry, PeerRegistry, ReputationTracker, PipelineTracker) -- a
// deliberate, disclosed limitation, not a gap. A coordinator restart loses
// demand history and the window starts fresh.
export class DemandTracker {
  private readonly clock: () => number;
  private readonly timestamps = new Map<string, number[]>();

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  recordRequest(modelId: string): void {
    const list = this.timestamps.get(modelId);
    if (list) {
      list.push(this.clock());
    } else {
      this.timestamps.set(modelId, [this.clock()]);
    }
  }

  recentDemand(modelId: string): number {
    const list = this.timestamps.get(modelId);
    if (!list) {
      return 0;
    }
    const cutoff = this.clock() - WINDOW_MS;
    // Prune in place (lazy, on read) -- same style as NodeRegistry's own
    // prune-on-iterate pattern -- so a model with no recent traffic
    // doesn't accumulate an unbounded timestamp list forever.
    let firstLiveIndex = 0;
    while (firstLiveIndex < list.length && list[firstLiveIndex] <= cutoff) {
      firstLiveIndex++;
    }
    if (firstLiveIndex > 0) {
      list.splice(0, firstLiveIndex);
    }
    return list.length;
  }
}
