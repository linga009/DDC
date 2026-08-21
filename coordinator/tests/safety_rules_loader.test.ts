import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSafetyRules, SafetyRulesError } from "../src/safety_rules_loader.ts";

function withRulesFile(content: string, run: (filePath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "safety-rules-test-"));
  const filePath = join(dir, "rules.json");
  writeFileSync(filePath, content, "utf-8");
  try {
    run(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loads a valid rules file into KeywordRule[] with term rules matching by word boundary", () => {
  withRulesFile(
    JSON.stringify({ rules: [{ category: "test_category", term: "danger phrase" }] }),
    filePath => {
      const rules = loadSafetyRules(filePath);
      assert.equal(rules.length, 1);
      assert.equal(rules[0].category, "test_category");
      assert.equal(rules[0].pattern.test("this contains a danger phrase in it"), true);
      assert.equal(rules[0].pattern.test("this does not contain the marker"), false);
      // Word-boundary, not substring: "dangerphrase" (no space) must not match.
      assert.equal(rules[0].pattern.test("dangerphrase jammed together"), false);
    },
  );
});

test("a term rule matches case-insensitively", () => {
  withRulesFile(
    JSON.stringify({ rules: [{ category: "test_category", term: "danger phrase" }] }),
    filePath => {
      const rules = loadSafetyRules(filePath);
      assert.equal(rules[0].pattern.test("THIS CONTAINS A DANGER PHRASE HERE"), true);
    },
  );
});

test("a term containing regex metacharacters is treated literally, not as regex syntax", () => {
  withRulesFile(
    JSON.stringify({ rules: [{ category: "test_category", term: "lose 100+ pounds fast" }] }),
    filePath => {
      const rules = loadSafetyRules(filePath);
      assert.equal(rules[0].pattern.test("you can lose 100+ pounds fast with this plan"), true);
      // If "+" weren't escaped, it would be a regex quantifier ("one or
      // more of the preceding character", i.e. one or more "0"s) rather
      // than a literal plus sign -- so this input, which has an extra "0"
      // instead of a literal "+", would incorrectly match too. It must not.
      assert.equal(rules[0].pattern.test("you can lose 1000 pounds fast with this plan"), false);
    },
  );
});

test("a pattern rule is compiled and used as raw regex source, not word-boundary-wrapped", () => {
  withRulesFile(
    JSON.stringify({ rules: [{ category: "test_category", pattern: "danger\\d+" }] }),
    filePath => {
      const rules = loadSafetyRules(filePath);
      // Substring match, no word boundaries: "xdanger42x" should match
      // because pattern rules are used as-is.
      assert.equal(rules[0].pattern.test("xdanger42x"), true);
      assert.equal(rules[0].pattern.test("no digits here"), false);
    },
  );
});

test("multiple rules across multiple categories all load correctly", () => {
  withRulesFile(
    JSON.stringify({
      rules: [
        { category: "cat_one", term: "marker one" },
        { category: "cat_two", term: "marker two" },
        { category: "cat_one", pattern: "marker\\s*three" },
      ],
    }),
    filePath => {
      const rules = loadSafetyRules(filePath);
      assert.equal(rules.length, 3);
      assert.deepEqual(rules.map(r => r.category), ["cat_one", "cat_two", "cat_one"]);
    },
  );
});

test("throws SafetyRulesError when the file does not exist", () => {
  assert.throws(
    () => loadSafetyRules(join(tmpdir(), "definitely-does-not-exist-12345.json")),
    SafetyRulesError,
  );
});

test("throws SafetyRulesError with a message naming the problem when JSON is malformed", () => {
  withRulesFile("{ this is not valid json", filePath => {
    assert.throws(() => loadSafetyRules(filePath), (err: unknown) => {
      assert.ok(err instanceof SafetyRulesError);
      assert.match((err as Error).message, /not valid JSON/);
      return true;
    });
  });
});

test("throws SafetyRulesError when the top-level shape has no rules array", () => {
  withRulesFile(JSON.stringify({ notRules: [] }), filePath => {
    assert.throws(() => loadSafetyRules(filePath), (err: unknown) => {
      assert.ok(err instanceof SafetyRulesError);
      assert.match((err as Error).message, /"rules" array/);
      return true;
    });
  });
});

test("throws SafetyRulesError with the rule index when a rule is missing category", () => {
  withRulesFile(
    JSON.stringify({ rules: [{ term: "no category here" }] }),
    filePath => {
      assert.throws(() => loadSafetyRules(filePath), (err: unknown) => {
        assert.ok(err instanceof SafetyRulesError);
        assert.match((err as Error).message, /index 0/);
        assert.match((err as Error).message, /category/);
        return true;
      });
    },
  );
});

test("throws SafetyRulesError when a rule has both term and pattern", () => {
  withRulesFile(
    JSON.stringify({ rules: [{ category: "c", term: "a", pattern: "b" }] }),
    filePath => {
      assert.throws(() => loadSafetyRules(filePath), (err: unknown) => {
        assert.ok(err instanceof SafetyRulesError);
        assert.match((err as Error).message, /exactly one/);
        return true;
      });
    },
  );
});

test("throws SafetyRulesError when a rule has neither term nor pattern", () => {
  withRulesFile(
    JSON.stringify({ rules: [{ category: "c" }] }),
    filePath => {
      assert.throws(() => loadSafetyRules(filePath), (err: unknown) => {
        assert.ok(err instanceof SafetyRulesError);
        assert.match((err as Error).message, /exactly one/);
        return true;
      });
    },
  );
});

test("throws SafetyRulesError when a pattern rule's regex source does not compile", () => {
  withRulesFile(
    JSON.stringify({ rules: [{ category: "c", pattern: "[unclosed" }] }),
    filePath => {
      assert.throws(() => loadSafetyRules(filePath), (err: unknown) => {
        assert.ok(err instanceof SafetyRulesError);
        assert.match((err as Error).message, /invalid regex/);
        return true;
      });
    },
  );
});

test("accepts a URL object directly (not just a string path)", () => {
  withRulesFile(
    JSON.stringify({ rules: [{ category: "c", term: "url object test" }] }),
    filePath => {
      const rules = loadSafetyRules(new URL(`file://${filePath.replace(/\\/g, "/")}`));
      assert.equal(rules.length, 1);
    },
  );
});
