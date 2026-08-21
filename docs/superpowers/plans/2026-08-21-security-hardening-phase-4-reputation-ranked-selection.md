# Security Hardening Phase 4: Reputation-Ranked Node Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /generate` pick the highest reputation-scored node
among active, trusted, `servesModel`-matching candidates instead of the
first one found, breaking exact ties (most commonly several untested
nodes) uniformly at random instead of always favoring whichever node
registered first.

**Architecture:** `ReputationTracker` gains one new pure method,
`score(nodeId): number` — a Laplace-smoothed agreement ratio,
`(agreements + 1) / (agreements + disagreements + 2)`. `server.ts` gains a
new exported pure function, `selectNode(nodes, reputation, modelId,
random)`, which filters candidates by `servesModel`, ranks them by
`score()`, and picks the max (breaking ties via the injected `random`
function). `createServer(...)` gains one new optional parameter,
`random: () => number = Math.random`, threaded only into the `/generate`
route's call to `selectNode`. No changes to `NodeRegistry`,
`ReputationTracker`'s existing methods, or any other route.

**Tech Stack:** Coordinator: Node.js native TypeScript, `node:test`,
`node:assert/strict`. No new dependencies.

## Global Constraints

- **Never add a `Co-Authored-By: Claude` trailer to any commit.** State
  this in every dispatch — it does not carry over automatically.
- Coordinator: zero npm dependencies. Only `node:http`, `node:test`,
  `node:assert/strict`, `node:crypto`, native `fetch`, `AbortSignal.timeout`.
- `ReputationTracker`'s existing methods (`isTrusted`, `getStats`,
  `recordAgreement`, `recordDisagreement`, the constructor) are **not
  modified** by this plan — only one new method, `score()`, is added.
- `NodeRegistry` is **not modified** by this plan at all.
- Run coordinator tests: `cd coordinator && npm test`.
- This plan runs in its own git worktree at
  `.worktrees/security-phase-4-reputation-ranked-selection` (branch
  `security-phase-4-reputation-ranked-selection`), created via the
  `using-git-worktrees` skill before Task 1 starts, off `master`.

---

### Task 1: `ReputationTracker.score()`

**Files:**
- Modify: `coordinator/src/reputation_tracker.ts`
- Test: `coordinator/tests/reputation_tracker.test.ts`

**Interfaces:**
- Produces: `ReputationTracker.score(nodeId: string): number` — new public
  method. Task 2 depends on exactly this name and signature.

- [ ] **Step 1: Write the failing tests**

Append these tests to the end of `coordinator/tests/reputation_tracker.test.ts`
(the file already imports `test`, `assert`, and `ReputationTracker` — no
new imports needed):

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd coordinator && npm test -- --test-name-pattern="score for a never-seen|score approaches 1|score approaches 0|equal agreements and disagreements score|more evidence at the same|scores are computed independently"`
Expected: FAIL — `tracker.score is not a function` (the method doesn't
exist yet).

- [ ] **Step 3: Write minimal implementation**

In `coordinator/src/reputation_tracker.ts`, find the existing `getStats`
method:

```typescript
  getStats(nodeId: string): NodeStats {
    const entry = this.stats.get(nodeId);
    return entry ? { ...entry } : { agreements: 0, disagreements: 0 };
  }
}
```

Replace it with (adding the new `score` method directly after `getStats`,
before the closing `}` of the class):

```typescript
  getStats(nodeId: string): NodeStats {
    const entry = this.stats.get(nodeId);
    return entry ? { ...entry } : { agreements: 0, disagreements: 0 };
  }

  score(nodeId: string): number {
    const { agreements, disagreements } = this.getStats(nodeId);
    return (agreements + 1) / (agreements + disagreements + 2);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd coordinator && npm test -- --test-name-pattern="score for a never-seen|score approaches 1|score approaches 0|equal agreements and disagreements score|more evidence at the same|scores are computed independently"`
Expected: PASS (all new tests green).

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `cd coordinator && npm test`
Expected: PASS — all pre-existing tests (none of them call `score()`, so
none should need changes) plus the 6 new tests from this task.

- [ ] **Step 6: Commit**

```bash
git add coordinator/src/reputation_tracker.ts coordinator/tests/reputation_tracker.test.ts
git commit -m "Add ReputationTracker.score(): a Laplace-smoothed agreement ratio"
```

---

### Task 2: `selectNode()`, `createServer()`'s `random` parameter, and `/generate` wiring

**Files:**
- Modify: `coordinator/src/server.ts`
- Modify: `coordinator/tests/server.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `ReputationTracker.score(nodeId: string): number` from Task 1.
- Produces: `export function selectNode(nodes: NodeInfo[], reputation: ReputationTracker, modelId: string, random: () => number): NodeInfo | undefined`
  and `createServer(registry, catalog, peers, classifier, reputation, authToken, random: () => number = Math.random)`
  — nothing later in this plan depends on these (this is the last task),
  but both are exported/available for direct testing.

- [ ] **Step 1: Write the failing tests**

First, update the imports at the top of `coordinator/tests/server.test.ts`.
Find:

```typescript
import { createServer } from "../src/server.ts";
import { NodeRegistry } from "../src/registry.ts";
```

Replace with:

```typescript
import { createServer, selectNode } from "../src/server.ts";
import { NodeRegistry, type NodeInfo } from "../src/registry.ts";
```

Next, update `startTestServer` to accept and thread through an optional
`random` function. Find:

```typescript
async function startTestServer(
  catalogEntries: CatalogEntry[] = DEFAULT_TEST_CATALOG,
  peers: PeerRegistry = new PeerRegistry(),
  classifier: SafetyClassifier = new KeywordSafetyClassifier([]),
  reputation: ReputationTracker = new ReputationTracker(),
  authToken: string = TEST_AUTH_TOKEN,
) {
  const registry = new NodeRegistry();
  const catalog = new ModelCatalog(catalogEntries);
  const server = createServer(registry, catalog, peers, classifier, reputation, authToken);
```

Replace with:

```typescript
async function startTestServer(
  catalogEntries: CatalogEntry[] = DEFAULT_TEST_CATALOG,
  peers: PeerRegistry = new PeerRegistry(),
  classifier: SafetyClassifier = new KeywordSafetyClassifier([]),
  reputation: ReputationTracker = new ReputationTracker(),
  authToken: string = TEST_AUTH_TOKEN,
  random: () => number = Math.random,
) {
  const registry = new NodeRegistry();
  const catalog = new ModelCatalog(catalogEntries);
  const server = createServer(registry, catalog, peers, classifier, reputation, authToken, random);
```

Now add the new tests. First, direct unit tests for `selectNode` — add
these directly after the `authFetch` helper function (i.e. right before
the first `test(...)` call in the file, so they sit with the other
top-of-file setup-adjacent tests):

```typescript
test("selectNode returns undefined when no candidate matches the requested model", () => {
  const reputation = new ReputationTracker();
  const nodes: NodeInfo[] = [
    { nodeId: "a", endpoint: "http://x", deviceTier: "desktop", servesModel: "other-model" },
  ];
  const result = selectNode(nodes, reputation, "tinyllama-1.1b", () => {
    throw new Error("random should not be called");
  });
  assert.equal(result, undefined);
});

test("selectNode returns the single matching candidate without calling random", () => {
  const reputation = new ReputationTracker();
  const nodes: NodeInfo[] = [
    { nodeId: "a", endpoint: "http://x", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
  ];
  const result = selectNode(nodes, reputation, "tinyllama-1.1b", () => {
    throw new Error("random should not be called");
  });
  assert.equal(result?.nodeId, "a");
});

test("selectNode picks the higher-scoring candidate without calling random", () => {
  const reputation = new ReputationTracker();
  reputation.recordAgreement("good");
  reputation.recordAgreement("good");
  reputation.recordAgreement("good");
  reputation.recordDisagreement("bad");
  reputation.recordDisagreement("bad");
  reputation.recordDisagreement("bad");
  const nodes: NodeInfo[] = [
    { nodeId: "bad", endpoint: "http://x", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
    { nodeId: "good", endpoint: "http://y", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
  ];
  const result = selectNode(nodes, reputation, "tinyllama-1.1b", () => {
    throw new Error("random should not be called");
  });
  assert.equal(result?.nodeId, "good");
});

test("selectNode breaks a tie using the injected random function, low end of the range", () => {
  const reputation = new ReputationTracker();
  const nodes: NodeInfo[] = [
    { nodeId: "a", endpoint: "http://x", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
    { nodeId: "b", endpoint: "http://y", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
    { nodeId: "c", endpoint: "http://z", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
  ];
  const result = selectNode(nodes, reputation, "tinyllama-1.1b", () => 0);
  assert.equal(result?.nodeId, "a");
});

test("selectNode breaks a tie using the injected random function, high end of the range", () => {
  const reputation = new ReputationTracker();
  const nodes: NodeInfo[] = [
    { nodeId: "a", endpoint: "http://x", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
    { nodeId: "b", endpoint: "http://y", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
    { nodeId: "c", endpoint: "http://z", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
  ];
  const result = selectNode(nodes, reputation, "tinyllama-1.1b", () => 0.999);
  assert.equal(result?.nodeId, "c");
});

test("selectNode ignores candidates that don't match the requested model even when they score higher", () => {
  const reputation = new ReputationTracker();
  reputation.recordAgreement("wrong-model-node");
  reputation.recordAgreement("wrong-model-node");
  const nodes: NodeInfo[] = [
    { nodeId: "wrong-model-node", endpoint: "http://x", deviceTier: "desktop", servesModel: "small-7b" },
    { nodeId: "right-model-node", endpoint: "http://y", deviceTier: "desktop", servesModel: "tinyllama-1.1b" },
  ];
  const result = selectNode(nodes, reputation, "tinyllama-1.1b", () => {
    throw new Error("random should not be called");
  });
  assert.equal(result?.nodeId, "right-model-node");
});
```

Finally, add these two HTTP-level tests directly after the existing test
`"POST /generate excludes a reputation-ejected node from routing"` (the
last test in the `/generate` block):

```typescript
test("POST /generate routes to the higher-scoring node when two trusted nodes serve the same model", async () => {
  const goodStub = await startStubNodeAgent(() => ({ status: 200, body: { text: "from the well-reputed node" } }));
  const untestedStub = await startStubNodeAgent(() => ({ status: 200, body: { text: "from the untested node" } }));
  const { server, baseUrl } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: untestedStub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });
    const goodRegisterRes = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: goodStub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });
    const { nodeId: goodNodeId } = await goodRegisterRes.json();

    for (let i = 0; i < 10; i++) {
      await authFetch(`${baseUrl}/nodes/${goodNodeId}/reputation/agree`, { method: "POST" });
    }

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b" }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "from the well-reputed node" });
  } finally {
    server.close();
    goodStub.server.close();
    untestedStub.server.close();
  }
});

test("POST /generate breaks a tie between equally-scored nodes using the injected random function", async () => {
  const firstStub = await startStubNodeAgent(() => ({ status: 200, body: { text: "from the first-registered node" } }));
  const secondStub = await startStubNodeAgent(() => ({ status: 200, body: { text: "from the second-registered node" } }));
  const { server, baseUrl } = await startTestServer(undefined, undefined, undefined, undefined, undefined, () => 0.999);
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: firstStub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: secondStub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b" }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "from the second-registered node" });
  } finally {
    server.close();
    firstStub.server.close();
    secondStub.server.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd coordinator && npm test -- --test-name-pattern="selectNode|routes to the higher-scoring node|breaks a tie between equally-scored"`
Expected: FAIL — `selectNode` is not exported from `server.ts` yet (a
TypeScript/module resolution error), and the two HTTP-level tests fail
because `/generate` still picks by first-match, not score (the "breaks a
tie" test in particular will be flaky-wrong: it may pass or fail depending
on registration order, since nothing routes by score yet).

- [ ] **Step 3: Write minimal implementation**

In `coordinator/src/server.ts`, update the import from `./registry.ts`.
Find:

```typescript
import { NodeRegistry, type DeviceTier } from "./registry.ts";
```

Replace with:

```typescript
import { NodeRegistry, type DeviceTier, type NodeInfo } from "./registry.ts";
```

Next, add the `selectNode` function. Find:

```typescript
async function federatedActiveNodeCount(registry: NodeRegistry, peers: PeerRegistry, reputation: ReputationTracker, authToken: string): Promise<number> {
  const local = registry.listActive(reputation).length;
  const peerCounts = await Promise.all(
    peers.listActive().map(peer => fetchPeerCapacity(peer.endpoint, authToken)));
  return local + peerCounts.reduce((sum, n) => sum + n, 0);
}

export function createServer(registry: NodeRegistry, catalog: ModelCatalog, peers: PeerRegistry, classifier: SafetyClassifier, reputation: ReputationTracker, authToken: string) {
```

Replace with:

```typescript
async function federatedActiveNodeCount(registry: NodeRegistry, peers: PeerRegistry, reputation: ReputationTracker, authToken: string): Promise<number> {
  const local = registry.listActive(reputation).length;
  const peerCounts = await Promise.all(
    peers.listActive().map(peer => fetchPeerCapacity(peer.endpoint, authToken)));
  return local + peerCounts.reduce((sum, n) => sum + n, 0);
}

// Ranks candidates serving `modelId` by ReputationTracker.score() and
// returns the highest-scoring one. Ties (most commonly: several untested
// nodes, which all score the neutral 0.5) are broken by picking uniformly
// at random among the tied set, so equally-trusted nodes share load
// instead of one perpetually winning by registration order. `random` is
// injected (mirroring NodeRegistry's injectable `clock`) so callers can
// pin the tie-break for deterministic tests; it is never invoked when
// there's a unique highest scorer.
export function selectNode(nodes: NodeInfo[], reputation: ReputationTracker, modelId: string, random: () => number): NodeInfo | undefined {
  const candidates = nodes.filter(n => n.servesModel === modelId);
  if (candidates.length === 0) {
    return undefined;
  }
  let bestScore = -Infinity;
  let best: NodeInfo[] = [];
  for (const node of candidates) {
    const s = reputation.score(node.nodeId);
    if (s > bestScore) {
      bestScore = s;
      best = [node];
    } else if (s === bestScore) {
      best.push(node);
    }
  }
  return best.length === 1 ? best[0] : best[Math.floor(random() * best.length)];
}

export function createServer(registry: NodeRegistry, catalog: ModelCatalog, peers: PeerRegistry, classifier: SafetyClassifier, reputation: ReputationTracker, authToken: string, random: () => number = Math.random) {
```

Finally, wire `selectNode` into the `/generate` handler. Find:

```typescript
        const node = registry.listActive(reputation).find(n => n.servesModel === candidate.modelId);
```

Replace with:

```typescript
        const node = selectNode(registry.listActive(reputation), reputation, candidate.modelId, random);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd coordinator && npm test -- --test-name-pattern="selectNode|routes to the higher-scoring node|breaks a tie between equally-scored"`
Expected: PASS (all new tests green).

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `cd coordinator && npm test`
Expected: PASS — every pre-existing test (including every other
`/generate` test, which all involve exactly one matching node and so are
behaviorally unaffected — `selectNode` with one candidate returns it
without calling `random`) plus every test added in Tasks 1–2.

- [ ] **Step 6: Update README.md**

First, find this paragraph (in the `POST /generate` description, right
after the endpoint list):

```markdown
still only Phase A of the request-routing initiative: node selection is a
simple first-match scan over active nodes (not load- or locality-aware),
there is no background pre-warming of pipelines ahead of demand, and there
```

Replace with:

```markdown
still only Phase A of the request-routing initiative: node selection is
reputation-ranked as of Security Hardening Phase 4 (see below) rather than
a raw first-match scan, but is still not locality-aware or a general load
balancer, there is no background pre-warming of pipelines ahead of demand,
and there
```

Next, find this paragraph (immediately after the reputation-ledger/
spot-check paragraph, right before the `**Caveat:**` paragraph about
`POST /peers/register`):

```markdown
Reputation endpoints themselves stay operable on an
already-ejected node (so future spot-check results can still be recorded
for it) — only capacity-facing views exclude it.

**Caveat:** `POST /peers/register` now requires `SWARM_AUTH_TOKEN` (see
```

Replace with:

```markdown
Reputation endpoints themselves stay operable on an
already-ejected node (so future spot-check results can still be recorded
for it) — only capacity-facing views exclude it.

**Security Hardening Phase 4 adds reputation-ranked node selection to
`POST /generate`.** Previously it picked the first active, trusted node
matching the requested `servesModel` (`Array.prototype.find` in `Map`
insertion order); it now scores every such candidate with
`ReputationTracker.score()` — a Laplace-smoothed agreement ratio,
`(agreements + 1) / (agreements + disagreements + 2)` — and picks the
highest-scoring one, breaking exact ties (most commonly: several untested
nodes, which all score a neutral `0.5`) by choosing uniformly at random
among them rather than always favoring whichever node happened to register
first. This changes *ranking* only, not *eligibility* — a node still has
to pass `isTrusted()`'s existing minSamples/disagreementThreshold gate to
be a candidate at all. In practice this ranks mostly-untested nodes today:
nothing in this codebase automatically calls the reputation-recording
endpoints from `/generate`'s own outcomes, so real ranking signal only
exists where an operator or external tool has manually recorded it — a
future automatic-feedback phase is real potential follow-on work, not
implemented here. The score is also only as durable as the `nodeId` it's
attached to — see the endpoint-aliasing caveat in "Known gaming vectors"
below; an operator can mint a fresh, neutral-scoring identity for the same
physical node by re-registering under an alias. This is not a general load
balancer: there is no in-flight-request tracking or capacity weighting,
only a random tie-break among exactly-equal scores.

**Caveat:** `POST /peers/register` now requires `SWARM_AUTH_TOKEN` (see
```

Finally, find this text (in the "Locality grouping is self-reported and
unverified" paragraph):

```markdown
request-routing system in this repo yet consumes it — `POST /generate`
(Phase A, see below) is a simple first-match scan over active nodes with no
locality-awareness at all, and this repo still has no cross-instance
```

Replace with:

```markdown
request-routing system in this repo yet consumes it — `POST /generate`
(Phase A, see below) ranks candidates by reputation score (Security
Hardening Phase 4, see above) but has no locality-awareness at all, and
this repo still has no cross-instance
```

- [ ] **Step 7: Full verification**

Run: `cd coordinator && npm test`
Expected: PASS, all tests (pre-existing plus every test added in Tasks 1–2).

Then a live check — start the real coordinator and confirm reputation
actually changes routing. Using two real `swarm-node-agent` processes here
isn't practical without built GGUF fixtures, so this check uses the same
real-coordinator-plus-stub-HTTP-node approach the automated tests use, but
driven from the command line to catch anything the test harness might
mask:

```bash
cd coordinator
SWARM_AUTH_TOKEN=verify-token PORT=18320 node src/main.ts &
sleep 1
node -e '
const http = require("http");
function stub(text) {
  return new Promise(resolve => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text }));
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
  });
}
(async () => {
  const good = await stub("GOOD NODE OUTPUT");
  const untested = await stub("UNTESTED NODE OUTPUT");
  const token = "verify-token";
  const base = "http://127.0.0.1:18320";
  async function post(path, body) {
    const res = await fetch(base + path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(body) });
    return res.json();
  }
  await post("/nodes/register", { endpoint: `http://127.0.0.1:${untested.port}`, deviceTier: "desktop", servesModel: "tinyllama-1.1b" });
  const { nodeId } = await post("/nodes/register", { endpoint: `http://127.0.0.1:${good.port}`, deviceTier: "desktop", servesModel: "tinyllama-1.1b" });
  for (let i = 0; i < 10; i++) {
    await fetch(`${base}/nodes/${nodeId}/reputation/agree`, { method: "POST", headers: { authorization: "Bearer " + token } });
  }
  const result = await post("/generate", { prompt: "hi", modelId: "tinyllama-1.1b" });
  console.log("routed to:", result.text, "(expect GOOD NODE OUTPUT)");
  good.server.close();
  untested.server.close();
})();
'
kill %1
```

Expected: `routed to: GOOD NODE OUTPUT (expect GOOD NODE OUTPUT)` — confirms
`/generate` picked the well-reputed node over the untested one against a
real running coordinator, not just the test harness. Confirm no orphaned
`node.exe` process remains afterward (`tasklist //FI "IMAGENAME eq
node.exe" //FO CSV` on Windows should show nothing from this check once
the `kill` above has taken effect).

- [ ] **Step 8: Commit**

```bash
git add coordinator/src/server.ts coordinator/tests/server.test.ts README.md
git commit -m "Rank /generate node selection by reputation score instead of first-match"
```

---

## What this plan does not do

- **No automatic reputation feedback from `/generate`'s own outcomes.**
  Ranking orders whatever reputation data already exists; it does not
  create a source of that data. Real future work, not scoped here (see
  the design doc's Rejected Approaches).
- **No change to `isTrusted()`'s eligibility gate.** A node must already
  pass the existing eligibility check to be a ranking candidate.
- **No general load-balancing.** The random tie-break spreads load only
  among exactly-tied candidates; there is no in-flight-request tracking or
  capacity weighting.
- **No locality-awareness.** Ranking is reputation-only.
- **Does not address the endpoint-aliasing gap** Security Hardening
  Phase 3's whole-branch review disclosed — a `nodeId`'s score is only as
  durable as the identity it's attached to, which is stable per endpoint
  *string*, not per physical device.
- **No exposure of `score()` via any endpoint.** `GET
  /nodes/:nodeId/reputation`'s response shape is unchanged; `score()` is
  consumed internally by `/generate`'s selection step only.
