import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPipeline } from "../src/pipeline_selector.ts";
import { ReputationTracker } from "../src/reputation_tracker.ts";
import type { NodeInfo } from "../src/registry.ts";

function node(overrides: Partial<NodeInfo> & { nodeId: string }): NodeInfo {
  return { endpoint: `http://127.0.0.1:${overrides.nodeId}`, deviceTier: "desktop", ...overrides };
}

test("selectPipeline returns undefined when fewer candidates exist than requiredNodeCount", () => {
  const nodes = [node({ nodeId: "a" }), node({ nodeId: "b" })];
  const reputation = new ReputationTracker();
  assert.equal(selectPipeline(nodes, reputation, 3), undefined);
});

test("selectPipeline picks the highest-reputation-score candidate as driver", () => {
  const nodes = [node({ nodeId: "a" }), node({ nodeId: "b" }), node({ nodeId: "c" })];
  const reputation = new ReputationTracker();
  reputation.recordAgreement("b");
  reputation.recordAgreement("b");
  const selection = selectPipeline(nodes, reputation, 2);
  assert.equal(selection?.driver.nodeId, "b");
});

test("selectPipeline breaks a tie in driver memory preference toward the higher self-reported value", () => {
  const nodes = [
    node({ nodeId: "a", availableMemoryMb: 4000 }),
    node({ nodeId: "b", availableMemoryMb: 32000 }),
  ];
  const reputation = new ReputationTracker();  // both untested -- identical 0.5 score
  const selection = selectPipeline(nodes, reputation, 2);
  assert.equal(selection?.driver.nodeId, "b");
});

test("selectPipeline treats a missing availableMemoryMb as 0 for the tiebreak, never excluding the node", () => {
  const nodes = [
    node({ nodeId: "a" }),  // no availableMemoryMb at all
    node({ nodeId: "b", availableMemoryMb: 1 }),
  ];
  const reputation = new ReputationTracker();
  const selection = selectPipeline(nodes, reputation, 1);
  assert.equal(selection?.driver.nodeId, "b");
});

test("selectPipeline prefers compute contributors sharing the driver's localityGroup", () => {
  const nodes = [
    node({ nodeId: "driver", localityGroup: "home-lan" }),
    node({ nodeId: "same-lan", localityGroup: "home-lan" }),
    node({ nodeId: "other-lan", localityGroup: "office-lan" }),
  ];
  const reputation = new ReputationTracker();
  reputation.recordAgreement("driver");
  reputation.recordAgreement("driver");
  const selection = selectPipeline(nodes, reputation, 2);
  assert.equal(selection?.driver.nodeId, "driver");
  assert.equal(selection?.computeContributors.length, 1);
  assert.equal(selection?.computeContributors[0].nodeId, "same-lan");
});

test("selectPipeline falls back to any remaining candidate when not enough share the driver's locality", () => {
  const nodes = [
    node({ nodeId: "driver", localityGroup: "home-lan" }),
    node({ nodeId: "elsewhere", localityGroup: "office-lan" }),
  ];
  const reputation = new ReputationTracker();
  reputation.recordAgreement("driver");
  reputation.recordAgreement("driver");
  const selection = selectPipeline(nodes, reputation, 2);
  assert.equal(selection?.computeContributors.length, 1);
  assert.equal(selection?.computeContributors[0].nodeId, "elsewhere");
});

test("selectPipeline for requiredNodeCount 1 returns the driver alone with no compute contributors", () => {
  const nodes = [node({ nodeId: "solo" })];
  const reputation = new ReputationTracker();
  const selection = selectPipeline(nodes, reputation, 1);
  assert.equal(selection?.driver.nodeId, "solo");
  assert.deepEqual(selection?.computeContributors, []);
});

test("selectPipeline breaks an exact tie among remaining candidates using the injected random function", () => {
  const nodes = [
    node({ nodeId: "driver" }),
    node({ nodeId: "tied-a" }),
    node({ nodeId: "tied-b" }),
  ];
  const reputation = new ReputationTracker();
  reputation.recordAgreement("driver");
  reputation.recordAgreement("driver");
  // Both "tied-a"/"tied-b" are untested (identical 0.5 score, no locality
  // group, identical 0 memory) -- deterministic ordering depends entirely
  // on the injected random function, exactly mirroring how selectNode()
  // (Security Hardening Phase 4) already proves its own tie-break.
  const pickA = selectPipeline(nodes, reputation, 2, () => 0);
  const pickB = selectPipeline(nodes, reputation, 2, () => 0.999);
  const picked = new Set([pickA?.computeContributors[0].nodeId, pickB?.computeContributors[0].nodeId]);
  assert.equal(picked.size, 2, "different random() outputs must be able to select different tied candidates");
});
