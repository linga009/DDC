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
