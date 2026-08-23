import { test } from "node:test";
import assert from "node:assert/strict";
import { PipelineTracker } from "../src/pipeline_tracker.ts";

test("get returns undefined for a model with no tracked pipeline", () => {
  const tracker = new PipelineTracker();
  assert.equal(tracker.get("mixtral-8x7b"), undefined);
});

test("markWarm then get reports the warm pipeline", () => {
  const tracker = new PipelineTracker();
  tracker.markWarm("mixtral-8x7b", "driver-node-id", ["contrib-1", "contrib-2"]);
  assert.deepEqual(tracker.get("mixtral-8x7b"), {
    driverNodeId: "driver-node-id",
    computeNodeIds: ["contrib-1", "contrib-2"],
    state: "warm",
  });
});

test("markFailed then get reports the failed state", () => {
  const tracker = new PipelineTracker();
  tracker.markFailed("mixtral-8x7b");
  assert.deepEqual(tracker.get("mixtral-8x7b"), { driverNodeId: undefined, computeNodeIds: [], state: "failed" });
});

test("markWarm after markFailed overwrites the tracked state for that model", () => {
  const tracker = new PipelineTracker();
  tracker.markFailed("mixtral-8x7b");
  tracker.markWarm("mixtral-8x7b", "driver-node-id", []);
  assert.equal(tracker.get("mixtral-8x7b")?.state, "warm");
});

test("tracking is independent per model id", () => {
  const tracker = new PipelineTracker();
  tracker.markWarm("mixtral-8x7b", "driver-a", []);
  tracker.markWarm("mixtral-8x22b", "driver-b", []);
  assert.equal(tracker.get("mixtral-8x7b")?.driverNodeId, "driver-a");
  assert.equal(tracker.get("mixtral-8x22b")?.driverNodeId, "driver-b");
});
