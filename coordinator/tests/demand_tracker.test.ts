import { test } from "node:test";
import assert from "node:assert/strict";
import { DemandTracker } from "../src/demand_tracker.ts";

test("recentDemand is 0 for a model with no recorded requests", () => {
  const tracker = new DemandTracker();
  assert.equal(tracker.recentDemand("some-model"), 0);
});

test("recentDemand counts requests recorded within the window", () => {
  const clock = { now: 1000 };
  const tracker = new DemandTracker(() => clock.now);
  tracker.recordRequest("model-a");
  tracker.recordRequest("model-a");
  tracker.recordRequest("model-a");
  assert.equal(tracker.recentDemand("model-a"), 3);
});

test("recentDemand excludes requests older than the 60-second window", () => {
  const clock = { now: 1000 };
  const tracker = new DemandTracker(() => clock.now);
  tracker.recordRequest("model-a");
  clock.now += 30000;
  tracker.recordRequest("model-a");
  clock.now += 30001; // now 60001ms after the FIRST request -- it should have aged out
  assert.equal(tracker.recentDemand("model-a"), 1);
});

test("recentDemand is tracked independently per model", () => {
  const tracker = new DemandTracker();
  tracker.recordRequest("model-a");
  tracker.recordRequest("model-a");
  tracker.recordRequest("model-b");
  assert.equal(tracker.recentDemand("model-a"), 2);
  assert.equal(tracker.recentDemand("model-b"), 1);
});

test("recentDemand for a model whose requests all aged out returns 0, not stale data", () => {
  const clock = { now: 1000 };
  const tracker = new DemandTracker(() => clock.now);
  tracker.recordRequest("model-a");
  clock.now += 60001;
  assert.equal(tracker.recentDemand("model-a"), 0);
});
