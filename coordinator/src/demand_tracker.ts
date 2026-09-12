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
    const now = this.clock();
    const list = this.timestamps.get(modelId);
    if (list) {
      // Prune on write as well as on read. POST /generate records every
      // request it routes, for EVERY model -- but recentDemand() is only
      // ever read for models the pool manager tracks (requiredNodeCount >
      // 1), which is none of them in the real default catalog. Without
      // this line a single-node model's timestamp list is appended to on
      // the hot path and never once read, so it grows for the life of the
      // process. Costs nothing in the common case: the loop stops on the
      // first unexpired entry and the splice is skipped entirely when
      // nothing has aged out.
      this.pruneExpired(list, now);
      list.push(now);
    } else {
      this.timestamps.set(modelId, [now]);
    }
  }

  recentDemand(modelId: string): number {
    const list = this.timestamps.get(modelId);
    if (!list) {
      return 0;
    }
    this.pruneExpired(list, this.clock());
    return list.length;
  }

  // Drops every timestamp at or before the window cutoff. In place --
  // same style as NodeRegistry's own prune-on-iterate pattern -- so no
  // model accumulates an unbounded timestamp list. The list is appended
  // to in clock order, so everything expired is a prefix.
  private pruneExpired(list: number[], now: number): void {
    const cutoff = now - WINDOW_MS;
    let firstLiveIndex = 0;
    while (firstLiveIndex < list.length && list[firstLiveIndex] <= cutoff) {
      firstLiveIndex++;
    }
    if (firstLiveIndex > 0) {
      list.splice(0, firstLiveIndex);
    }
  }
}
