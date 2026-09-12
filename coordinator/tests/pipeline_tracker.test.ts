import { test } from "node:test";
import assert from "node:assert/strict";
import { PipelineTracker, type PooledPipeline } from "../src/pipeline_tracker.ts";

function entry(overrides: Partial<PooledPipeline> = {}): PooledPipeline {
  return {
    pipelineId: "pipeline-1",
    driverNodeId: "driver-1",
    computeNodeIds: [],
    launcherId: "launcher-1",
    state: "warm",
    lastUsedAt: 1000,
    ...overrides,
  };
}

test("getPool returns an empty array for a model with no entries", () => {
  const tracker = new PipelineTracker();
  assert.deepEqual(tracker.getPool("mixtral-8x7b"), []);
});

test("addEntry then getPool reports the added entry", () => {
  const tracker = new PipelineTracker();
  tracker.addEntry("mixtral-8x7b", entry());
  assert.deepEqual(tracker.getPool("mixtral-8x7b"), [entry()]);
});

test("addEntry accumulates multiple entries for the same model", () => {
  const tracker = new PipelineTracker();
  tracker.addEntry("mixtral-8x7b", entry({ pipelineId: "p1", driverNodeId: "d1", launcherId: "l1" }));
  tracker.addEntry("mixtral-8x7b", entry({ pipelineId: "p2", driverNodeId: "d2", launcherId: "l2" }));
  assert.equal(tracker.getPool("mixtral-8x7b").length, 2);
});

test("removeEntry removes exactly the named entry, leaving others", () => {
  const tracker = new PipelineTracker();
  tracker.addEntry("mixtral-8x7b", entry({ pipelineId: "p1" }));
  tracker.addEntry("mixtral-8x7b", entry({ pipelineId: "p2" }));
  tracker.removeEntry("mixtral-8x7b", "p1");
  const pool = tracker.getPool("mixtral-8x7b");
  assert.equal(pool.length, 1);
  assert.equal(pool[0].pipelineId, "p2");
});

test("removeEntry for an unknown pipelineId is a harmless no-op", () => {
  const tracker = new PipelineTracker();
  tracker.addEntry("mixtral-8x7b", entry({ pipelineId: "p1" }));
  tracker.removeEntry("mixtral-8x7b", "nonexistent");
  assert.equal(tracker.getPool("mixtral-8x7b").length, 1);
});

test("removeEntry for a model with no pool at all is a harmless no-op", () => {
  const tracker = new PipelineTracker();
  tracker.removeEntry("nonexistent-model", "p1");
  assert.deepEqual(tracker.getPool("nonexistent-model"), []);
});

test("markEntryFailed sets that entry's state to failed without removing it", () => {
  const tracker = new PipelineTracker();
  tracker.addEntry("mixtral-8x7b", entry({ pipelineId: "p1", state: "warm" }));
  tracker.markEntryFailed("mixtral-8x7b", "p1");
  const pool = tracker.getPool("mixtral-8x7b");
  assert.equal(pool.length, 1);
  assert.equal(pool[0].state, "failed");
});

test("markEntryFailed for an unknown pipelineId is a harmless no-op", () => {
  const tracker = new PipelineTracker();
  tracker.addEntry("mixtral-8x7b", entry({ pipelineId: "p1", state: "warm" }));
  tracker.markEntryFailed("mixtral-8x7b", "nonexistent");
  assert.equal(tracker.getPool("mixtral-8x7b")[0].state, "warm");
});

test("tracking is independent per model id", () => {
  const tracker = new PipelineTracker();
  tracker.addEntry("mixtral-8x7b", entry({ pipelineId: "p1" }));
  tracker.addEntry("mixtral-8x22b", entry({ pipelineId: "p2" }));
  assert.equal(tracker.getPool("mixtral-8x7b").length, 1);
  assert.equal(tracker.getPool("mixtral-8x22b").length, 1);
  assert.equal(tracker.getPool("mixtral-8x7b")[0].pipelineId, "p1");
});
