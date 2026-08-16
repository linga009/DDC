# Safety Classifier Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the entry-point classification gate the spec's Safety & Social Responsibility section requires — a prompt is checked while it's still complete plaintext, before it's decomposed and routed into the swarm, since no single node (or the coordinator, post-sharding) can inspect it after that point.

**Scope correction, stated plainly up front:** the spec's language ("each instance runs an open-weight safety classifier, e.g. Llama Guard") implies a multi-gigabyte generative model doing real content classification. That is out of scope for this plan, for a concrete reason, not a vague one: this sandbox's network has repeatedly struggled with files far smaller than a real safety-classifier model (a 669MB and a 90MB download each needed multiple retries across Plans 1 and 4), and a real classifier model is materially larger than either. What this plan actually builds is the **pluggable gate architecture** — an interface any classifier (including a real model-backed one, wired in later by implementing the same interface against the C++ `InferenceEngine`) can plug into, plus a reference implementation whose only job is to prove the plumbing works, not to perform real content moderation. The reference classifier's test rules are deliberately synthetic markers (e.g. a literal test token), not real-world harmful-content examples — this plan is testing gate *behavior* (block/allow, category reporting, fail-safe defaults), not building or evaluating an actual moderation policy. A real policy is a model-selection and safety-evaluation decision for whoever wires in a production classifier, not something to invent here.

**Architecture:** Lives in the coordinator (`coordinator/`, Node.js/TypeScript), not the C++ inference engine — matching the spec's own reasoning: the coordinator's API gateway is one of the only points in the whole system that ever sees a complete, unsharded prompt. A `SafetyClassifier` interface (`classify(prompt) -> { safe, categories }`) is the pluggable contract. `KeywordSafetyClassifier` is the reference implementation: a list of caller-supplied `{ pattern, category }` rules, no built-in "real" rules shipped. `POST /classify` exposes it over HTTP so it can be called as a gate before a request is ever handed to the swarm.

**Tech Stack:** Same as Plans 3/6 (Node.js built-ins only, zero npm dependencies).

## Global Constraints

- Everything from Plan 3/6's Global Constraints still applies: zero npm dependencies, no placeholders, injectable dependencies for anything that needs deterministic testing.
- **No real-world harmful-content strings anywhere in this plan, its tests, or its code** — all example/test rules use synthetic markers (e.g. `UNSAFE_TEST_TOKEN`), never realistic-sounding harmful requests. This is a deliberate, non-negotiable constraint: the goal is testing gate mechanics, not producing or exercising a content policy.
- The reference classifier ships with **zero default rules** (an empty rule list classifies everything as safe) — a caller must explicitly supply rules to get any blocking behavior. This makes the "fails open with no configuration" behavior an explicit, visible choice in every test and every caller, not a hidden default a reader has to discover.
- `POST /classify` must **fail closed on classifier error**, not fail open: if the classifier throws, the endpoint returns `safe: false` (block) with an error category, never silently treats an error as "safe". Availability of the gate is not a reason to let an unclassified prompt through.
- This plan does not wire `/classify` into any existing request-submission flow (there isn't one yet — the coordinator tracks capacity and peers, but actual inference still happens by calling the C++ `InferenceEngine` directly, with no coordinator-mediated request path). This plan builds the gate as a standalone, fully-testable unit ready for that future wiring, matching how Plan 5's `complete_speculative` was built ready for Plan 2's remote engines without actually combining them yet.

---

### Task 1: `SafetyClassifier` interface and `KeywordSafetyClassifier` reference implementation

**Files:**
- Create: `coordinator/src/safety_classifier.ts`
- Create: `coordinator/tests/safety_classifier.test.ts`

**Interfaces:**
- Consumes: nothing (pure, no model, no I/O).
- Produces:
  ```ts
  interface ClassificationResult {
    safe: boolean;
    categories: string[];
  }

  interface SafetyClassifier {
    classify(prompt: string): Promise<ClassificationResult>;
  }

  interface KeywordRule {
    pattern: RegExp;
    category: string;
  }

  class KeywordSafetyClassifier implements SafetyClassifier {
    constructor(rules: KeywordRule[]);
    classify(prompt: string): Promise<ClassificationResult>;
  }
  ```
  Task 2 consumes `SafetyClassifier` (the interface, not the concrete class) so the HTTP layer stays decoupled from any specific classifier implementation.

- [ ] **Step 1: Write the failing tests**

Create `coordinator/tests/safety_classifier.test.ts`:
```ts
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
```

Run:
```bash
cd coordinator && node --test tests/safety_classifier.test.ts
```
Expected: **FAIL** — `src/safety_classifier.ts` doesn't exist yet.

- [ ] **Step 2: Implement it**

Create `coordinator/src/safety_classifier.ts`:
```ts
export interface ClassificationResult {
  safe: boolean;
  categories: string[];
}

export interface SafetyClassifier {
  classify(prompt: string): Promise<ClassificationResult>;
}

export interface KeywordRule {
  pattern: RegExp;
  category: string;
}

// A deliberately naive, non-production reference classifier. It exists to
// prove the SafetyClassifier gate's plumbing (block/allow decisions,
// category reporting, fail-closed error handling in the HTTP layer) works
// correctly -- it is NOT a real content-moderation implementation, and
// ships with zero rules by default. Wiring in a real classifier (e.g. a
// model-backed one calling the C++ InferenceEngine) means implementing
// SafetyClassifier, not extending this class.
export class KeywordSafetyClassifier implements SafetyClassifier {
  private readonly rules: KeywordRule[];

  constructor(rules: KeywordRule[]) {
    this.rules = rules;
  }

  async classify(prompt: string): Promise<ClassificationResult> {
    const categories: string[] = [];
    for (const rule of this.rules) {
      if (rule.pattern.test(prompt)) {
        categories.push(rule.category);
      }
    }
    return { safe: categories.length === 0, categories };
  }
}
```

- [ ] **Step 3: Run the tests and verify they pass**

```bash
cd coordinator && node --test tests/safety_classifier.test.ts
```
Expected: **PASS** — all 5 tests.

- [ ] **Step 4: Commit**

```bash
git add coordinator/src/safety_classifier.ts coordinator/tests/safety_classifier.test.ts
git commit -m "Add SafetyClassifier interface and KeywordSafetyClassifier reference implementation"
```

---

### Task 2: `POST /classify` HTTP endpoint

**Files:**
- Modify: `coordinator/src/server.ts`
- Modify: `coordinator/src/main.ts`
- Modify: `coordinator/tests/server.test.ts`

**Interfaces:**
- Consumes: `SafetyClassifier` (the interface) from Task 1.
- Produces: `createServer` gains a new required parameter for the classifier; new endpoint:
  ```
  POST /classify   body: { prompt: string }   -> { safe: boolean, categories: string[] }
  ```
  This is the surface a future request-submission flow (not built yet) would call before routing a prompt into the swarm.

- [ ] **Step 1: Write the failing tests**

Add to `coordinator/tests/server.test.ts`. Read the current file first to match `startTestServer`'s actual current shape (it already takes a `catalogEntries` parameter as of Plan 6) and extend it to also accept and pass through a `SafetyClassifier`, defaulting to a `KeywordSafetyClassifier` with an empty rule list if the test doesn't care about classification behavior specifically.

```ts
import { KeywordSafetyClassifier } from "../src/safety_classifier.ts";

test("POST /classify returns safe:true for a prompt matching no configured rules", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "an ordinary prompt" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.safe, true);
    assert.deepEqual(body.categories, []);
  } finally {
    server.close();
  }
});

test("POST /classify returns safe:false and categories for a prompt matching a configured rule", async () => {
  const classifier = new KeywordSafetyClassifier([
    { pattern: /UNSAFE_TEST_TOKEN/, category: "test_category" },
  ]);
  const { server, baseUrl } = await startTestServer(undefined, classifier);
  try {
    const res = await fetch(`${baseUrl}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "contains UNSAFE_TEST_TOKEN here" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.safe, false);
    assert.deepEqual(body.categories, ["test_category"]);
  } finally {
    server.close();
  }
});

test("POST /classify rejects a request with a missing or non-string prompt", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: 12345 }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("POST /classify fails closed (safe:false) if the classifier itself throws", async () => {
  const throwingClassifier = {
    classify: async () => {
      throw new Error("classifier backend unavailable");
    },
  };
  const { server, baseUrl } = await startTestServer(undefined, throwingClassifier);
  try {
    const res = await fetch(`${baseUrl}/classify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "anything" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.safe, false);
    assert.ok(body.categories.length > 0);
  } finally {
    server.close();
  }
});
```

Update `startTestServer` to accept an optional `classifier` parameter (defaulting to `new KeywordSafetyClassifier([])`) and pass it to `createServer`. Match the existing helper's actual current parameter style rather than assuming the exact signature above — check the real current file.

Run:
```bash
cd coordinator && node --test tests/server.test.ts
```
Expected: **FAIL** — `createServer` doesn't accept a classifier yet, `/classify` doesn't exist.

- [ ] **Step 2: Implement the endpoint**

Modify `coordinator/src/server.ts`. Add the import and parameter:
```ts
import { SafetyClassifier } from "./safety_classifier.ts";

export function createServer(registry: NodeRegistry, catalog: ModelCatalog, peers: PeerRegistry, classifier: SafetyClassifier) {
```

Add the route (following the existing routing pattern, inside the same try/catch scope that already handles malformed JSON):
```ts
if (method === "POST" && parts[0] === "classify" && parts.length === 1) {
  const body = await readJsonBody(req);
  if (typeof body !== "object" || body === null) {
    sendJson(res, 400, { error: "request body must be a JSON object" });
    return;
  }
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.prompt !== "string") {
    sendJson(res, 400, { error: "prompt must be a string" });
    return;
  }
  try {
    const result = await classifier.classify(candidate.prompt);
    sendJson(res, 200, result);
  } catch {
    // Fail closed: a classifier error must never be treated as "safe".
    sendJson(res, 200, { safe: false, categories: ["classifier_error"] });
  }
  return;
}
```

Note the inner `try/catch` around `classifier.classify(...)` specifically — this is deliberate and separate from the outer JSON-parsing try/catch, since a classifier throwing must produce a `safe: false` result (per the Global Constraints' fail-closed requirement), not the outer catch's generic `500`.

- [ ] **Step 3: Update `main.ts`**

Modify `coordinator/src/main.ts` to construct a default classifier and pass it to `createServer`:
```ts
import { KeywordSafetyClassifier } from "./safety_classifier.ts";
// ...
const classifier = new KeywordSafetyClassifier([]);
const server = createServer(registry, catalog, peers, classifier);
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd coordinator && npm test
```
Expected: **PASS** — full suite, including all 4 new tests.

- [ ] **Step 5: Commit**

```bash
git add coordinator/src/server.ts coordinator/src/main.ts coordinator/tests/server.test.ts
git commit -m "Add POST /classify safety gate endpoint, fails closed on classifier error"
```

---

## What this plan does not do

Does not perform real content classification — the reference classifier ships with zero rules and its test rules are synthetic markers, not a content policy (see the Scope Correction above). Does not integrate a real open-weight classifier model (e.g. Llama Guard) — that's real follow-on work requiring a model-selection and safety-evaluation decision this plan deliberately doesn't make. Does not wire `/classify` into any request-submission flow, since none exists yet in this codebase — it's a standalone, tested gate ready for that future wiring. Does not add authentication to `/classify` (matches every other endpoint's existing no-auth, trusted-LAN scope).
