import { test } from "node:test";
import assert from "node:assert/strict";
import { KeywordSafetyClassifier } from "../src/safety_classifier.ts";

test("a classifier with zero rules treats every prompt as safe", async () => {
  const classifier = new KeywordSafetyClassifier([]);

  const result = await classifier.classify("anything at all, this default has no rules");

  assert.equal(result.safe, true);
  assert.deepEqual(result.categories, []);
});

test("a matching rule flags the prompt as unsafe and reports its category", async () => {
  const classifier = new KeywordSafetyClassifier([
    { pattern: /UNSAFE_TEST_TOKEN/, category: "test_category" },
  ]);

  const result = await classifier.classify("this contains UNSAFE_TEST_TOKEN in it");

  assert.equal(result.safe, false);
  assert.deepEqual(result.categories, ["test_category"]);
});

test("a non-matching prompt against a configured rule is safe", async () => {
  const classifier = new KeywordSafetyClassifier([
    { pattern: /UNSAFE_TEST_TOKEN/, category: "test_category" },
  ]);

  const result = await classifier.classify("this prompt does not contain the marker");

  assert.equal(result.safe, true);
  assert.deepEqual(result.categories, []);
});

test("multiple matching rules all report their categories, not just the first", async () => {
  const classifier = new KeywordSafetyClassifier([
    { pattern: /MARKER_ONE/, category: "category_one" },
    { pattern: /MARKER_TWO/, category: "category_two" },
    { pattern: /MARKER_THREE/, category: "category_three" },
  ]);

  const result = await classifier.classify("has MARKER_ONE and MARKER_THREE but not the other");

  assert.equal(result.safe, false);
  assert.deepEqual(result.categories, ["category_one", "category_three"]);
});

test("rule matching is case-insensitive-agnostic to the pattern's own flags -- a rule without the i flag is case-sensitive", async () => {
  const classifier = new KeywordSafetyClassifier([
    { pattern: /exact_case_marker/, category: "case_sensitive_category" },
  ]);

  const lower = await classifier.classify("contains exact_case_marker here");
  const upper = await classifier.classify("contains EXACT_CASE_MARKER here");

  assert.equal(lower.safe, false);
  assert.equal(upper.safe, true);
});

test("a rule with the g flag gives a stable verdict across repeated calls on the identical prompt, not an alternating one", async () => {
  const classifier = new KeywordSafetyClassifier([
    { pattern: /GLOBAL_FLAG_TOKEN/g, category: "global_flag_category" },
  ]);
  const prompt = "this prompt contains GLOBAL_FLAG_TOKEN in it";

  // RegExp.prototype.test on a /g (or /y) pattern mutates lastIndex on
  // match, so a naive implementation that reuses the caller's RegExp object
  // would alternate true/false/true/... across calls on the SAME prompt.
  // Assert three consecutive calls all agree, to rule out "passes on call 2
  // by luck" -- the bug is a two-call oscillation, so a third call is what
  // actually proves the fix rather than a coincidental phase.
  const first = await classifier.classify(prompt);
  const second = await classifier.classify(prompt);
  const third = await classifier.classify(prompt);

  assert.equal(first.safe, false);
  assert.equal(second.safe, false);
  assert.equal(third.safe, false);
  assert.deepEqual(first.categories, ["global_flag_category"]);
  assert.deepEqual(second.categories, ["global_flag_category"]);
  assert.deepEqual(third.categories, ["global_flag_category"]);
});

test("a rule with the sticky (y) flag also gives a stable verdict across repeated calls", async () => {
  const classifier = new KeywordSafetyClassifier([
    { pattern: /STICKY_FLAG_TOKEN/y, category: "sticky_flag_category" },
  ]);
  // The y flag anchors matching at lastIndex, so the match must start at
  // index 0 for this prompt -- use a prompt where the token is the prefix.
  const prompt = "STICKY_FLAG_TOKEN appears at the start";

  const first = await classifier.classify(prompt);
  const second = await classifier.classify(prompt);
  const third = await classifier.classify(prompt);

  assert.equal(first.safe, false);
  assert.equal(second.safe, false);
  assert.equal(third.safe, false);
});

test("mutating the caller's rules array after construction does not affect the classifier's already-built policy", async () => {
  const callerRules = [
    { pattern: /ORIGINAL_TOKEN/, category: "original_category" },
  ];
  const classifier = new KeywordSafetyClassifier(callerRules);

  // Mutate the caller's own array AFTER construction -- the classifier must
  // have copied it, not stored it by reference.
  callerRules.push({ pattern: /PUSHED_AFTER_CONSTRUCTION/, category: "pushed_category" });

  const result = await classifier.classify("this prompt contains PUSHED_AFTER_CONSTRUCTION");

  assert.equal(result.safe, true);
  assert.deepEqual(result.categories, []);
});
