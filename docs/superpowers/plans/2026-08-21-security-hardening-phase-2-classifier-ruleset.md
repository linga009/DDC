# Security Hardening Phase 2: Real Safety-Classifier Ruleset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the coordinator's zero-rule default `KeywordSafetyClassifier` with a real, curated ruleset loaded from a JSON config file, with fail-fast startup validation — closing "the safety gate currently reports every prompt as safe."

**Architecture:** `KeywordSafetyClassifier` (`coordinator/src/safety_classifier.ts`) needs **zero changes** — it already accepts arbitrary `KeywordRule[]` with correct, stateless regex handling. This plan adds a new JSON rules file, a new loader module that validates the file and fails fast on any problem, and wires `main.ts` to use it instead of `[]`.

**Tech Stack:** Coordinator: Node.js native TypeScript, `node:fs`, `node:test`. No new dependencies.

## Global Constraints

- **Never add a `Co-Authored-By: Claude` trailer to any commit.** State this in every dispatch — it does not carry over automatically.
- Coordinator: zero npm dependencies. Only `node:http`, `node:test`, `node:assert/strict`, `node:crypto`, `node:fs`, `node:os`, `node:path`, native `fetch`, `AbortSignal.timeout`, etc.
- `KeywordSafetyClassifier` (`coordinator/src/safety_classifier.ts`) is **not modified** by this plan. Its `KeywordRule` type (`{ category: string; pattern: RegExp }`, already-compiled `RegExp`) is the exact output type the new loader must produce.
- The rules file path is resolved via `import.meta.url` relative to `main.ts`'s own module location, **not** an environment variable — unlike `SWARM_AUTH_TOKEN`, this means no existing test that spawns `main.ts` needs modification, since the file will simply exist on disk once this plan creates it.
- **Windows path safety:** never derive a filesystem path from a `file://` URL via `.pathname` (it produces a mangled path like `/C:/Users/...` on Windows, breaking `fs.readFileSync`). Either use `node:url`'s `fileURLToPath()`, or — the approach this plan uses — accept a `string | URL` directly and hand it straight to `fs.readFileSync`, which handles both correctly on every platform without manual conversion.
- Run coordinator tests: `cd coordinator && npm test`.
- This plan runs in its own git worktree at `.worktrees/security-phase-2-classifier-ruleset` (branch `security-phase-2-classifier-ruleset`), created via the `using-git-worktrees` skill before Task 1 starts, off `master`.

---

### Task 1: Safety rules loader

**Files:**
- Create: `coordinator/src/safety_rules_loader.ts`
- Test: `coordinator/tests/safety_rules_loader.test.ts`

**Interfaces:**
- Consumes: `KeywordRule` type from `coordinator/src/safety_classifier.ts` (`{ category: string; pattern: RegExp }`).
- Produces: `loadSafetyRules(filePath: string | URL): KeywordRule[]` and `class SafetyRulesError extends Error` (exported so tests and, later, `main.ts` can distinguish this failure class if needed). Task 2's `main.ts` change depends on this exact function name, signature, and the fact that every validation failure throws `SafetyRulesError` with a message naming the specific problem.

- [ ] **Step 1: Write the failing tests**

`coordinator/tests/safety_rules_loader.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd coordinator && npm test -- --test-name-pattern="loads a valid rules file|throws SafetyRulesError"`
Expected: FAIL with a module-not-found error (`coordinator/src/safety_rules_loader.ts` doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

`coordinator/src/safety_rules_loader.ts`:

```typescript
import { readFileSync } from "node:fs";
import type { KeywordRule } from "./safety_classifier.ts";

export class SafetyRulesError extends Error {}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function loadSafetyRules(filePath: string | URL): KeywordRule[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    throw new SafetyRulesError(
      `failed to read safety rules file ${filePath}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new SafetyRulesError(
      `safety rules file ${filePath} is not valid JSON: ${(err as Error).message}`,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>).rules)
  ) {
    throw new SafetyRulesError(
      `safety rules file ${filePath} must be a JSON object with a "rules" array`,
    );
  }

  const rawRules = (parsed as { rules: unknown[] }).rules;
  const rules: KeywordRule[] = [];

  rawRules.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new SafetyRulesError(`safety rule at index ${index} must be an object`);
    }
    const candidate = entry as Record<string, unknown>;

    if (typeof candidate.category !== "string" || candidate.category.length === 0) {
      throw new SafetyRulesError(
        `safety rule at index ${index} must have a non-empty "category" string`,
      );
    }

    const hasTerm = typeof candidate.term === "string";
    const hasPattern = typeof candidate.pattern === "string";

    if (hasTerm && hasPattern) {
      throw new SafetyRulesError(
        `safety rule at index ${index} (category "${candidate.category}") must have exactly one of "term" or "pattern", not both`,
      );
    }
    if (!hasTerm && !hasPattern) {
      throw new SafetyRulesError(
        `safety rule at index ${index} (category "${candidate.category}") must have exactly one of "term" or "pattern"`,
      );
    }

    if (hasTerm) {
      const term = candidate.term as string;
      if (term.length === 0) {
        throw new SafetyRulesError(
          `safety rule at index ${index} (category "${candidate.category}") has an empty "term"`,
        );
      }
      rules.push({
        category: candidate.category,
        pattern: new RegExp(`\\b${escapeRegExp(term)}\\b`, "i"),
      });
    } else {
      // "pattern" is raw regex source, authored by hand -- unlike "term"
      // (which is escaped literal text), a hand-written pattern CAN express
      // catastrophic backtracking (e.g. nested quantifiers like (a+)+b).
      // There's no complexity linting here; a rule author adding a
      // "pattern" entry is responsible for keeping it simple and avoiding
      // nested/overlapping quantifiers.
      const source = candidate.pattern as string;
      let compiled: RegExp;
      try {
        compiled = new RegExp(source, "i");
      } catch (err) {
        throw new SafetyRulesError(
          `safety rule at index ${index} (category "${candidate.category}") has an invalid regex pattern "${source}": ${(err as Error).message}`,
        );
      }
      rules.push({ category: candidate.category, pattern: compiled });
    }
  });

  return rules;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd coordinator && npm test -- --test-name-pattern="loads a valid rules file|throws SafetyRulesError|term|pattern|category|url object"`
Expected: PASS (all new tests green).

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `cd coordinator && npm test`
Expected: PASS (all pre-existing tests plus the new ones from this task).

- [ ] **Step 6: Commit**

```bash
git add coordinator/src/safety_rules_loader.ts coordinator/tests/safety_rules_loader.test.ts
git commit -m "Add safety_rules_loader: validates and loads a JSON ruleset into KeywordRule[]"
```

---

### Task 2: Real curated ruleset + main.ts wiring

**Files:**
- Create: `coordinator/safety_rules.json`
- Modify: `coordinator/src/main.ts`
- Modify: `coordinator/tests/main.test.ts`

**Interfaces:**
- Consumes: `loadSafetyRules(filePath: string | URL): KeywordRule[]` and `SafetyRulesError` from Task 1.
- Produces: nothing consumed by a later task — this is the last code task. `coordinator/safety_rules.json` at the repo path `coordinator/safety_rules.json` is now a real, load-bearing file every future session should know exists (Task 3's README update documents this).

- [ ] **Step 1: Create the real ruleset file**

`coordinator/safety_rules.json`:

```json
{
  "rules": [
    { "category": "violence_and_weapons", "term": "how to build a bomb" },
    { "category": "violence_and_weapons", "term": "how to make a pipe bomb" },
    { "category": "violence_and_weapons", "term": "instructions for building an explosive device" },
    { "category": "violence_and_weapons", "term": "how to make a silencer for a gun" },
    { "category": "violence_and_weapons", "term": "3d print an untraceable firearm" },
    { "category": "violence_and_weapons", "term": "how to make sarin gas" },
    { "category": "violence_and_weapons", "term": "steps to build a homemade explosive" },
    { "category": "violence_and_weapons", "term": "how to weaponize a drone" },
    { "category": "csam", "term": "child sexual abuse material" },
    { "category": "csam", "term": "sexual content involving a minor" },
    { "category": "csam", "term": "sexualized images of children" },
    { "category": "csam", "term": "csam" },
    { "category": "self_harm", "term": "how to commit suicide" },
    { "category": "self_harm", "term": "most effective suicide method" },
    { "category": "self_harm", "term": "how to kill myself painlessly" },
    { "category": "self_harm", "term": "instructions for self-harm" },
    { "category": "self_harm", "term": "ways to end my life" },
    { "category": "self_harm", "term": "how to cut myself without getting caught" },
    { "category": "self_harm", "term": "lethal dose of pills" },
    { "category": "self_harm", "term": "encourage someone to kill themselves" },
    { "category": "illegal_drugs", "term": "how to synthesize methamphetamine" },
    { "category": "illegal_drugs", "term": "how to cook meth" },
    { "category": "illegal_drugs", "term": "how to make fentanyl at home" },
    { "category": "illegal_drugs", "term": "steps to manufacture mdma" },
    { "category": "illegal_drugs", "term": "how to extract dmt" },
    { "category": "illegal_drugs", "term": "recipe for making crack cocaine" },
    { "category": "illegal_drugs", "term": "how to grow opium poppies for heroin" },
    { "category": "illegal_drugs", "term": "how to make gbl" },
    { "category": "hate_speech_and_extremism", "term": "gas the jews" },
    { "category": "hate_speech_and_extremism", "pattern": "kill\\s+all\\s+(jews|muslims|black people|immigrants|gay people)" },
    { "category": "hate_speech_and_extremism", "term": "glorify the holocaust" },
    { "category": "hate_speech_and_extremism", "term": "how to join isis" },
    { "category": "hate_speech_and_extremism", "term": "how to join a neo-nazi group" },
    { "category": "hate_speech_and_extremism", "term": "white genocide conspiracy" },
    { "category": "hate_speech_and_extremism", "term": "ethnic cleansing is justified" },
    { "category": "hate_speech_and_extremism", "term": "praise a mass shooter" },
    { "category": "harassment", "term": "post someone's home address to harass them" },
    { "category": "harassment", "term": "coordinate a harassment campaign against" },
    { "category": "harassment", "term": "flood their inbox with hateful messages" },
    { "category": "harassment", "term": "dox someone without their consent" },
    { "category": "harassment", "term": "spread private photos without consent" },
    { "category": "harassment", "term": "organize a pile-on against a person online" },
    { "category": "fraud_and_scams", "term": "how to run a phishing scam" },
    { "category": "fraud_and_scams", "term": "write a fake invoice to defraud" },
    { "category": "fraud_and_scams", "term": "how to steal credit card numbers" },
    { "category": "fraud_and_scams", "term": "set up a ponzi scheme" },
    { "category": "fraud_and_scams", "term": "create a fake charity to scam donors" },
    { "category": "fraud_and_scams", "term": "how to commit identity theft" },
    { "category": "fraud_and_scams", "term": "clone someone's bank card" },
    { "category": "fraud_and_scams", "term": "romance scam script to extract money" },
    { "category": "malware_and_hacking", "term": "write ransomware to encrypt someone's files" },
    { "category": "malware_and_hacking", "term": "create a keylogger to steal passwords" },
    { "category": "malware_and_hacking", "term": "write a ddos attack script" },
    { "category": "malware_and_hacking", "term": "sql injection to steal a database" },
    { "category": "malware_and_hacking", "term": "how to bypass someone's password without permission" },
    { "category": "malware_and_hacking", "term": "create a botnet" },
    { "category": "malware_and_hacking", "term": "write a computer virus that spreads automatically" },
    { "category": "malware_and_hacking", "term": "exploit code for a zero-day vulnerability to attack" },
    { "category": "adult_sexual_content", "term": "explicit sexual roleplay" },
    { "category": "adult_sexual_content", "term": "generate pornographic content" },
    { "category": "adult_sexual_content", "term": "sexually explicit story involving" },
    { "category": "adult_sexual_content", "term": "erotic content generator" },
    { "category": "adult_sexual_content", "term": "nsfw sexual content request" },
    { "category": "adult_sexual_content", "term": "generate nude images of" },
    { "category": "misinformation_and_election_interference", "term": "write fake news to spread as real" },
    { "category": "misinformation_and_election_interference", "term": "create a deepfake script to deceive voters" },
    { "category": "misinformation_and_election_interference", "term": "fabricate evidence that the election was stolen" },
    { "category": "misinformation_and_election_interference", "term": "generate disinformation to suppress voter turnout" },
    { "category": "misinformation_and_election_interference", "term": "create a fake news article claiming" },
    { "category": "misinformation_and_election_interference", "term": "spread false information to manipulate an election" }
  ]
}
```

These are deliberate curation choices — **do not "improve" or expand them without understanding why they're shaped this way**:
- `csam` is kept to 4 generic, blunt terms with zero graphic specificity. This matches how real trust & safety systems handle this category (bluntly, not by enumerating specifics) — do not add more detailed/specific terms to this category.
- `hate_speech_and_extremism` uses demographic-group-plus-violent-intent framing (e.g. "kill all muslims") and named-extremist-org/historical-atrocity framing rather than any literal slur — deliberately avoiding committing a slur list to a public git repository. Do not add literal slurs to this category.
- `malware_and_hacking` phrases every rule with explicit malicious/unauthorized intent ("to steal", "without permission", "to attack") specifically so it doesn't false-positive on this repo's own legitimate security-research-adjacent context.
- `misinformation_and_election_interference` matches on **intent to fabricate/deceive**, never on any specific political claim or position, so the classifier can't be used to suppress legitimate political speech or debate.

- [ ] **Step 2: Write the failing test in `main.test.ts`**

Add this test to `coordinator/tests/main.test.ts`, after the existing whitespace-token `for` loop block (the last test in the file):

```typescript
test("main.ts refuses to start when the safety rules file is malformed", async () => {
  const env = {
    ...process.env,
    PORT: "0",
    SWARM_AUTH_TOKEN: "test-secret-token-1234",
  };
  // This test intentionally does NOT override the real rules file path --
  // main.ts resolves coordinator/safety_rules.json relative to its own
  // module location, not an env var (see Task 1's Global Constraints note).
  // Instead this test temporarily corrupts the real file, restoring it
  // in a finally block no matter what.
  const rulesPath = fileURLToPath(new URL("../safety_rules.json", import.meta.url));
  const original = readFileSync(rulesPath, "utf-8");
  writeFileSync(rulesPath, "{ this is not valid json", "utf-8");

  try {
    const child = spawn(process.execPath, [mainPath], { env });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const exitCode = await new Promise<number | null>(resolve => {
      child.on("exit", code => resolve(code));
    });
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /not valid JSON/);
  } finally {
    writeFileSync(rulesPath, original, "utf-8");
  }
});
```

Add this import to the top of `coordinator/tests/main.test.ts`, alongside the existing ones:

```typescript
import { readFileSync, writeFileSync } from "node:fs";
```

(`fileURLToPath` is **already** imported in this file — line 4, `import { fileURLToPath } from "node:url";` — and already used to build the `mainPath` constant. Do not add a second import of it; the new test above reuses that same existing import.)

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd coordinator && npm test -- --test-name-pattern="refuses to start when the safety rules file"`
Expected: FAIL — either a "file not found" error (since `coordinator/safety_rules.json` doesn't exist as a real file yet at this point if Step 1 hasn't been committed, or the test corrupts a file that gets read successfully by the still-unmodified `main.ts`, which doesn't call `loadSafetyRules` yet and therefore starts successfully regardless of the file's content) — either way, `assert.notEqual(exitCode, 0)` fails because the old `main.ts` doesn't validate this file at all yet.

- [ ] **Step 4: Wire `main.ts`**

In `coordinator/src/main.ts`, add this import alongside the existing ones:

```typescript
import { loadSafetyRules } from "./safety_rules_loader.ts";
```

Replace this line:

```typescript
const classifier = new KeywordSafetyClassifier([]);
```

with:

```typescript
const rules = loadSafetyRules(new URL("../safety_rules.json", import.meta.url));
const classifier = new KeywordSafetyClassifier(rules);
```

(No try/catch here — letting `loadSafetyRules`'s throw propagate as an uncaught exception is the fail-fast behavior: Node prints the error and exits non-zero automatically, the same shape as the existing `SWARM_AUTH_TOKEN` check's explicit `process.exit(1)`, just via a different mechanism. This is deliberate and matches the design doc's Architecture section.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd coordinator && npm test -- --test-name-pattern="refuses to start when the safety rules file"`
Expected: PASS.

- [ ] **Step 6: Run the full suite to confirm no regressions in the existing `main.test.ts` tests**

Run: `cd coordinator && npm test`
Expected: PASS, all tests — the 9 pre-existing `main.test.ts` tests (5 base + 4 whitespace-token cases) must still pass unmodified, since `coordinator/safety_rules.json` now exists as a real, valid file on disk and every spawn of `main.ts` finds and loads it successfully.

- [ ] **Step 7: Commit**

```bash
git add coordinator/safety_rules.json coordinator/src/main.ts coordinator/tests/main.test.ts
git commit -m "Load a real curated safety ruleset at startup instead of zero rules"
```

---

### Task 3: Documentation updates and final verification

**Files:**
- Modify: `README.md`
- Modify: `coordinator/public/index.html`

**Interfaces:**
- Consumes: the final behavior of Tasks 1-2.
- Produces: nothing consumed by a later task — this is the last task in this plan.

- [ ] **Step 1: Update README's `/classify` documentation**

Find this text in `README.md` (in the Coordinator service endpoint list):

```markdown
- `POST /classify` — pluggable safety gate: submit `{ "prompt": string }`,
  get back `{ safe: boolean, categories: string[] }`. **The shipped
  `KeywordSafetyClassifier` ships with zero rules by default and performs no
  real content moderation — it exists only to prove the gate's plumbing
  (fail-closed error handling, request/response shape, timeout behavior). A
  real classifier must be supplied by implementing the `SafetyClassifier`
  interface (`coordinator/src/safety_classifier.ts`).** `/classify` is
  also callable directly and independently of `/generate` below — it is
  not exclusively an internal implementation detail of routing.
```

Replace it with:

```markdown
- `POST /classify` — pluggable safety gate: submit `{ "prompt": string }`,
  get back `{ safe: boolean, categories: string[] }`. **The coordinator
  loads a real, curated keyword/pattern ruleset from
  `coordinator/safety_rules.json`** (10 categories: `violence_and_weapons`,
  `csam`, `self_harm`, `illegal_drugs`, `hate_speech_and_extremism`,
  `harassment`, `fraud_and_scams`, `malware_and_hacking`,
  `adult_sexual_content`, `misinformation_and_election_interference`) at
  startup, failing fast (refusing to start) if the file is missing or
  malformed — the same posture as `SWARM_AUTH_TOKEN`. **This is still
  pattern-matching, not semantic content understanding**: it catches
  prompts containing a configured term or pattern, and nothing else — it
  does not catch the same request rephrased, misspelled, translated into
  another language, or expressed in a genuinely novel way. Edit
  `coordinator/safety_rules.json` (no code change needed) to add rules — a
  plain `"term"` is the safe default (word-boundary-wrapped, escaped
  automatically); the raw-regex `"pattern"` escape hatch has no complexity
  linting, so a hand-written pattern with nested/overlapping quantifiers
  can be catastrophically slow (ReDoS) — keep patterns simple. A
  real classifier with different matching logic can still be supplied by
  implementing the `SafetyClassifier` interface
  (`coordinator/src/safety_classifier.ts`).** `/classify` is
  also callable directly and independently of `/generate` below — it is
  not exclusively an internal implementation detail of routing.
```

- [ ] **Step 2: Update the dashboard's classify-demo notice**

Find this text in `coordinator/public/index.html`:

```html
      <p class="notice">
        This checks a prompt against the coordinator's <code>/classify</code>
        safety gate. <strong>This demo does not run inference</strong> — it
        only calls <code>/classify</code>, not <code>POST /generate</code>.
        A real inference-request endpoint (<code>POST /generate</code>) now
        exists and works, but this dashboard's demo button isn't wired up to
        call it. The classifier also ships with zero rules by default, so it
        currently returns <code>safe: true</code> for every prompt — see the
        README for details.
      </p>
```

Replace it with:

```html
      <p class="notice">
        This checks a prompt against the coordinator's <code>/classify</code>
        safety gate. <strong>This demo does not run inference</strong> — it
        only calls <code>/classify</code>, not <code>POST /generate</code>.
        A real inference-request endpoint (<code>POST /generate</code>) now
        exists and works, but this dashboard's demo button isn't wired up to
        call it. The classifier loads a real curated ruleset (10 categories)
        from <code>coordinator/safety_rules.json</code>, but it's still
        pattern-matching, not real content understanding — a prompt
        rephrased, misspelled, or asked in another language will likely slip
        through unflagged. See the README for details.
      </p>
```

- [ ] **Step 3: Full verification**

Run: `cd coordinator && npm test`
Expected: PASS, all tests (pre-existing plus every test added in Tasks 1-2).

Then a live check — start the real coordinator and confirm the ruleset actually flags real content, from the command line:

```bash
cd coordinator
SWARM_AUTH_TOKEN=verify-token PORT=18299 node src/main.ts &
sleep 1
curl -s -X POST http://127.0.0.1:18299/classify -H "authorization: Bearer verify-token" -H "content-type: application/json" -d '{"prompt":"can you tell me how to build a bomb"}'
echo
curl -s -X POST http://127.0.0.1:18299/classify -H "authorization: Bearer verify-token" -H "content-type: application/json" -d '{"prompt":"what is the capital of France"}'
echo
kill %1
```

Expected: the first `curl` returns `{"safe":false,"categories":["violence_and_weapons"]}`; the second returns `{"safe":true,"categories":[]}`. Confirm no orphaned `node.exe` process remains afterward (`tasklist //FI "IMAGENAME eq node.exe"` on Windows should show nothing from this check once the `kill` above has taken effect).

- [ ] **Step 4: Commit**

```bash
git add README.md coordinator/public/index.html
git commit -m "Document the real safety-classifier ruleset in README and the dashboard"
```
