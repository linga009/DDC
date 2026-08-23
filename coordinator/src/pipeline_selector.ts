import type { NodeInfo } from "./registry.ts";
import type { ReputationTracker } from "./reputation_tracker.ts";

export interface PipelineSelection {
  driver: NodeInfo;
  computeContributors: NodeInfo[];
}

// Sorts by ReputationTracker.score() descending, then by availableMemoryMb
// descending (absent treated as 0 -- a soft preference, never an
// exclusion; see this plan's design doc, Architecture #3, for why this
// isn't a hard memory-requirement gate), then randomly among any
// remaining exact tie -- mirrors server.ts's existing selectNode() tie-break
// pattern (Security Hardening Phase 4) applied to a richer sort key.
function rankCandidates(nodes: NodeInfo[], reputation: ReputationTracker, random: () => number): NodeInfo[] {
  const withKeys = nodes.map(node => ({
    node,
    score: reputation.score(node.nodeId),
    memory: node.availableMemoryMb ?? 0,
  }));

  // First pass: sort by score and memory
  withKeys.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.memory !== b.memory) return b.memory - a.memory;
    return 0; // keep stable order for final tie-break
  });

  // Second pass: for each group of exact ties (same score and memory),
  // shuffle using the random function, mirroring selectNode's approach
  const result: typeof withKeys = [];
  let i = 0;
  while (i < withKeys.length) {
    const group: typeof withKeys = [withKeys[i]];
    let j = i + 1;
    // Find all nodes with identical score and memory
    while (j < withKeys.length &&
           withKeys[j].score === withKeys[i].score &&
           withKeys[j].memory === withKeys[i].memory) {
      group.push(withKeys[j]);
      j++;
    }
    // Shuffle this group using the random function (Fisher-Yates style,
    // one call per group like selectNode() does one call per tie)
    if (group.length === 1) {
      result.push(group[0]);
    } else {
      // Pick one from the group using random, append it, remove from group, repeat
      const shuffled = [...group];
      while (shuffled.length > 0) {
        const idx = Math.floor(random() * shuffled.length);
        result.push(shuffled[idx]);
        shuffled.splice(idx, 1);
      }
    }
    i = j;
  }

  return result.map(entry => entry.node);
}

// Given a set of already-active, already-trust-filtered candidates (the
// caller passes registry.listActive(reputation) -- this function does no
// filtering of its own beyond what's described here), picks a driver and
// requiredNodeCount-1 compute contributors. Returns undefined if fewer
// than requiredNodeCount candidates exist at all -- the caller (Task 7)
// treats that as "can't assemble a pipeline right now," not an error.
//
// Note for callers assembling a pipeline via a launcher (Task 7's
// ensurePipelineReady): the returned `driver` is a real NodeInfo drawn
// from the active pool, but a launcher-spawned driver is a BRAND NEW
// process the launcher creates on demand -- it isn't literally "promoted"
// from an existing NodeInfo. In that caller, `driver` functions only as a
// readiness signal ("the swarm already has requiredNodeCount trustworthy,
// already-registered candidates, so it's worth spawning"); only
// `computeContributors` is actually used to build the launcher's
// `--remote` list. This function still fully computes and returns
// `driver` because it's a real, independently useful part of this pure
// function's contract (e.g. for a future caller that picks among already-
// running drivers rather than spawning a fresh one) -- it's simply not
// every caller's concern.
export function selectPipeline(
  nodes: NodeInfo[],
  reputation: ReputationTracker,
  requiredNodeCount: number,
  random: () => number = Math.random,
): PipelineSelection | undefined {
  if (nodes.length < requiredNodeCount) {
    return undefined;
  }

  const ranked = rankCandidates(nodes, reputation, random);
  const driver = ranked[0];
  const remaining = ranked.slice(1);

  const sameLocality = remaining.filter(n => n.localityGroup !== undefined && n.localityGroup === driver.localityGroup);
  const otherCandidates = remaining.filter(n => !sameLocality.includes(n));
  const orderedContributorPool = [...sameLocality, ...otherCandidates];

  const computeContributors = orderedContributorPool.slice(0, requiredNodeCount - 1);
  return { driver, computeContributors };
}
