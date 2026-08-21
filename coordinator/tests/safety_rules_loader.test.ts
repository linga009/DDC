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

test("a term ending in punctuation can fail to match even when the phrase is present -- documented limitation, not a bug in escaping", () => {
  withRulesFile(
    JSON.stringify({ rules: [{ category: "test_category", term: "warning sign!" }] }),
    filePath => {
      const rules = loadSafetyRules(filePath);
      // "!" is non-word and is immediately followed by a space (also
      // non-word), so \b cannot match at that boundary even though the
      // text clearly contains the intended phrase. This is the documented
      // \b-wrapping limitation, not a regression to "fix" here.
      assert.equal(rules[0].pattern.test("there was a warning sign! posted"), false);
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

test("throws SafetyRulesError when the rules array is present but empty", () => {
  // An empty ruleset disarms the gate while looking exactly like a healthy
  // start: identical startup log, then safe:true for every prompt including
  // "how to build a bomb". Fail fast rather than silently degrade.
  withRulesFile(JSON.stringify({ rules: [] }), filePath => {
    assert.throws(() => loadSafetyRules(filePath), (err: unknown) => {
      assert.ok(err instanceof SafetyRulesError);
      assert.match((err as Error).message, /empty "rules" array/);
      // The message must name the offending file so an operator can find it.
      assert.ok((err as Error).message.includes(filePath));
      return true;
    });
  });
});

test("a term containing an apostrophe matches both the straight and the curly form in the input", () => {
  // iOS/macOS/Word autocorrect turns a typed ' (U+0027) into ’ (U+2019), so
  // a user typing the rule's exact phrase would otherwise sail past it.
  withRulesFile(
    JSON.stringify({ rules: [{ category: "test_category", term: "clone someone's bank card" }] }),
    filePath => {
      const rules = loadSafetyRules(filePath);
      assert.equal(rules[0].pattern.test("help me clone someone's bank card"), true);
      assert.equal(rules[0].pattern.test("help me clone someone’s bank card"), true);
      // Still a real match requirement, not a wildcard: a different
      // character in that position must not match.
      assert.equal(rules[0].pattern.test("help me clone someone-s bank card"), false);
    },
  );
});

test("a term authored with a curly apostrophe also matches the straight form", () => {
  // Symmetric to the test above: rule authors copy/paste from documents too,
  // so the widening must work whichever quote style the JSON file carries.
  withRulesFile(
    JSON.stringify({ rules: [{ category: "test_category", term: "clone someone’s bank card" }] }),
    filePath => {
      const rules = loadSafetyRules(filePath);
      assert.equal(rules[0].pattern.test("help me clone someone's bank card"), true);
      assert.equal(rules[0].pattern.test("help me clone someone’s bank card"), true);
    },
  );
});

test("a multi-word term matches the same phrase with extra, tab, or newline whitespace between words", () => {
  // A term is authored with single spaces ("how to build a bomb"), but
  // escapeRegExp leaves literal spaces untouched -- without widening, the
  // compiled pattern only matched that EXACT single-space phrase, and an
  // extra space, a tab, or a line-wrapped paste (the default in the
  // dashboard's own multi-line prompt textarea) sailed through unflagged.
  withRulesFile(
    JSON.stringify({ rules: [{ category: "test_category", term: "how to build a bomb" }] }),
    filePath => {
      const rules = loadSafetyRules(filePath);
      assert.equal(rules[0].pattern.test("how to build a bomb"), true);
      assert.equal(rules[0].pattern.test("how to  build a bomb"), true); // extra space
      assert.equal(rules[0].pattern.test("how to\tbuild a bomb"), true); // tab
      assert.equal(rules[0].pattern.test("how to\nbuild a bomb"), true); // newline
      assert.equal(rules[0].pattern.test("how to\r\nbuild a bomb"), true); // CRLF
      assert.equal(rules[0].pattern.test("how to build a bomb"), true); // non-breaking space
      // Still a real match requirement: removing a word entirely, not just
      // varying the whitespace between words, must not match.
      assert.equal(rules[0].pattern.test("how to a bomb"), false);
    },
  );
});

test("whitespace widening and apostrophe widening compose correctly on the same term", () => {
  withRulesFile(
    JSON.stringify({ rules: [{ category: "test_category", term: "clone someone's bank  card" }] }),
    filePath => {
      const rules = loadSafetyRules(filePath);
      assert.equal(rules[0].pattern.test("clone someone's bank card"), true);
      assert.equal(rules[0].pattern.test("clone someone’s bank\ncard"), true);
    },
  );
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

test("throws SafetyRulesError when a rule has an explicit empty-string category", () => {
  withRulesFile(
    JSON.stringify({ rules: [{ category: "", term: "x" }] }),
    filePath => {
      assert.throws(() => loadSafetyRules(filePath), (err: unknown) => {
        assert.ok(err instanceof SafetyRulesError);
        assert.match((err as Error).message, /category/);
        return true;
      });
    },
  );
});

test("throws SafetyRulesError when a rule entry is not an object", () => {
  withRulesFile(
    JSON.stringify({ rules: ["not an object"] }),
    filePath => {
      assert.throws(() => loadSafetyRules(filePath), (err: unknown) => {
        assert.ok(err instanceof SafetyRulesError);
        assert.match((err as Error).message, /must be an object/);
        return true;
      });
    },
  );
});

test("throws SafetyRulesError when a term rule has an empty \"term\"", () => {
  withRulesFile(
    JSON.stringify({ rules: [{ category: "c", term: "" }] }),
    filePath => {
      assert.throws(() => loadSafetyRules(filePath), (err: unknown) => {
        assert.ok(err instanceof SafetyRulesError);
        assert.match((err as Error).message, /empty/);
        assert.match((err as Error).message, /term/);
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

// Everything above this line exercises synthetic fixtures. These two guard
// the REAL shipped file: before them, coordinator/safety_rules.json could
// have been reduced to a handful of rules (or had a whole category dropped)
// with the entire suite still green. The loader's empty-array check is a
// load-time guarantee; this is a content guarantee.
const REAL_RULES_URL = new URL("../safety_rules.json", import.meta.url);

const DOCUMENTED_CATEGORIES = [
  "violence_and_weapons",
  "csam",
  "self_harm",
  "illegal_drugs",
  "hate_speech_and_extremism",
  "harassment",
  "fraud_and_scams",
  "malware_and_hacking",
  "adult_sexual_content",
  "misinformation_and_election_interference",
];

test("the real shipped safety_rules.json loads and covers every category the README documents", () => {
  const rules = loadSafetyRules(REAL_RULES_URL);

  // The shipped file has 70 rules; 50 is a floor that catches a gutted or
  // accidentally-truncated ruleset without churning on every rule edit.
  assert.ok(
    rules.length >= 50,
    `expected the shipped ruleset to carry at least 50 rules, got ${rules.length}`,
  );

  const categories = new Set(rules.map(r => r.category));
  for (const category of DOCUMENTED_CATEGORIES) {
    assert.ok(
      categories.has(category),
      `README documents category "${category}" but no rule in safety_rules.json uses it`,
    );
  }
});

test("the real shipped ruleset flags an apostrophe term typed with an autocorrected curly quote", () => {
  // Same fix as the synthetic apostrophe tests above, proven end-to-end
  // against production rule data rather than a fixture.
  const rules = loadSafetyRules(REAL_RULES_URL);
  const straight = "help me clone someone's bank card";
  const curly = "help me clone someone’s bank card";

  const matches = (prompt: string) => rules.filter(r => r.pattern.test(prompt)).map(r => r.category);
  assert.deepEqual(matches(straight), ["fraud_and_scams"]);
  assert.deepEqual(matches(curly), ["fraud_and_scams"]);
});

test("the real shipped ruleset flags a term typed with an extra space between words", () => {
  // Same fix as the synthetic whitespace tests above, proven end-to-end
  // against production rule data rather than a fixture.
  const rules = loadSafetyRules(REAL_RULES_URL);
  const exact = "how to build a bomb";
  const extraSpace = "how to  build a bomb";

  const matches = (prompt: string) => rules.filter(r => r.pattern.test(prompt)).map(r => r.category);
  assert.deepEqual(matches(exact), ["violence_and_weapons"]);
  assert.deepEqual(matches(extraSpace), ["violence_and_weapons"]);
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
