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

test("constructing with minSamples=0 throws", () => {
  assert.throws(() => new ReputationTracker(0, 0.5));
});

test("constructing with disagreementThreshold=1.5 throws", () => {
  assert.throws(() => new ReputationTracker(5, 1.5));
});

test("constructing with disagreementThreshold=0 throws (must be >0, not >=0)", () => {
  assert.throws(() => new ReputationTracker(5, 0));
});

test("constructing with valid values does not throw", () => {
  assert.doesNotThrow(() => new ReputationTracker());
  assert.doesNotThrow(() => new ReputationTracker(3, 0.75));
});

test("score for a never-seen node is exactly 0.5", () => {
  const tracker = new ReputationTracker();
  assert.equal(tracker.score("never-seen"), 0.5);
});

test("score approaches 1 as agreement-only evidence grows, and never reaches it", () => {
  const tracker = new ReputationTracker();
  tracker.recordAgreement("node-a");
  tracker.recordAgreement("node-a");
  const scoreAtTwo = tracker.score("node-a");
  for (let i = 0; i < 98; i++) {
    tracker.recordAgreement("node-a");
  }
  const scoreAtHundred = tracker.score("node-a");

  assert.ok(scoreAtTwo > 0.5);
  assert.ok(scoreAtHundred > scoreAtTwo);
  assert.ok(scoreAtHundred < 1);
});

test("score approaches 0 as disagreement-only evidence grows, and never reaches it", () => {
  const tracker = new ReputationTracker();
  tracker.recordDisagreement("node-a");
  tracker.recordDisagreement("node-a");
  const scoreAtTwo = tracker.score("node-a");
  for (let i = 0; i < 98; i++) {
    tracker.recordDisagreement("node-a");
  }
  const scoreAtHundred = tracker.score("node-a");

  assert.ok(scoreAtTwo < 0.5);
  assert.ok(scoreAtHundred < scoreAtTwo);
  assert.ok(scoreAtHundred > 0);
});

test("equal agreements and disagreements score exactly 0.5, same as a never-seen node", () => {
  const tracker = new ReputationTracker();
  tracker.recordAgreement("node-a");
  tracker.recordAgreement("node-a");
  tracker.recordAgreement("node-a");
  tracker.recordDisagreement("node-a");
  tracker.recordDisagreement("node-a");
  tracker.recordDisagreement("node-a");

  assert.equal(tracker.score("node-a"), 0.5);
});

test("more evidence at the same perfect ratio scores strictly higher", () => {
  const tracker = new ReputationTracker();
  tracker.recordAgreement("few-samples");
  tracker.recordAgreement("few-samples");
  for (let i = 0; i < 100; i++) {
    tracker.recordAgreement("many-samples");
  }

  assert.ok(tracker.score("many-samples") > tracker.score("few-samples"));
});

test("scores are computed independently per node", () => {
  const tracker = new ReputationTracker();
  tracker.recordAgreement("node-a");
  tracker.recordDisagreement("node-b");

  assert.ok(tracker.score("node-a") > 0.5);
  assert.ok(tracker.score("node-b") < 0.5);
});
