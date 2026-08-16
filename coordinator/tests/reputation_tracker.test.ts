import { test } from "node:test";
import assert from "node:assert/strict";
import { ReputationTracker } from "../src/reputation_tracker.ts";

test("a node with no recorded checks is trusted by default", () => {
  const tracker = new ReputationTracker();
  assert.equal(tracker.isTrusted("never-checked-node"), true);
});

test("a node with only agreements stays trusted", () => {
  const tracker = new ReputationTracker();
  tracker.recordAgreement("node-a");
  tracker.recordAgreement("node-a");
  tracker.recordAgreement("node-a");
  assert.equal(tracker.isTrusted("node-a"), true);
});

test("a single disagreement below the minimum sample size does not eject a node", () => {
  const tracker = new ReputationTracker(5, 0.5);
  tracker.recordDisagreement("node-a");
  assert.equal(tracker.isTrusted("node-a"), true);
});

test("consistent disagreement past the minimum sample size ejects a node", () => {
  const tracker = new ReputationTracker(5, 0.5);
  for (let i = 0; i < 5; i++) {
    tracker.recordDisagreement("node-a");
  }
  assert.equal(tracker.isTrusted("node-a"), false);
});

test("mixed results below the disagreement threshold keep a node trusted", () => {
  const tracker = new ReputationTracker(5, 0.5);
  // 2 disagreements out of 6 total = 33%, below the 50% threshold.
  tracker.recordAgreement("node-a");
  tracker.recordAgreement("node-a");
  tracker.recordDisagreement("node-a");
  tracker.recordAgreement("node-a");
  tracker.recordDisagreement("node-a");
  tracker.recordAgreement("node-a");
  assert.equal(tracker.isTrusted("node-a"), true);
});

test("mixed results at or above the disagreement threshold eject a node", () => {
  const tracker = new ReputationTracker(5, 0.5);
  // 3 disagreements out of 6 total = 50%, at the threshold.
  tracker.recordAgreement("node-a");
  tracker.recordDisagreement("node-a");
  tracker.recordAgreement("node-a");
  tracker.recordDisagreement("node-a");
  tracker.recordAgreement("node-a");
  tracker.recordDisagreement("node-a");
  assert.equal(tracker.isTrusted("node-a"), false);
});

test("nodes are scored independently", () => {
  const tracker = new ReputationTracker(3, 0.5);
  for (let i = 0; i < 3; i++) {
    tracker.recordDisagreement("bad-node");
  }
  tracker.recordAgreement("good-node");

  assert.equal(tracker.isTrusted("bad-node"), false);
  assert.equal(tracker.isTrusted("good-node"), true);
});

test("getStats reports raw counts for a node", () => {
  const tracker = new ReputationTracker();
  tracker.recordAgreement("node-a");
  tracker.recordAgreement("node-a");
  tracker.recordDisagreement("node-a");

  const stats = tracker.getStats("node-a");
  assert.equal(stats.agreements, 2);
  assert.equal(stats.disagreements, 1);
});

test("getStats for a never-seen node reports zero counts", () => {
  const tracker = new ReputationTracker();
  const stats = tracker.getStats("never-seen");
  assert.equal(stats.agreements, 0);
  assert.equal(stats.disagreements, 0);
});
