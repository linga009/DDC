# Trust/Reputation Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-node reputation scoring and ejection mechanism the spec's Trust & Security section describes — nodes that consistently disagree with independently-verified results get excluded from routing.

**Scope correction, stated up front:** the spec frames this as "reputation scoring based on agreement with redundant spot-checks" — implying an active mechanism that runs the same request on two nodes and compares outputs. That comparison mechanism doesn't exist yet: this repo has no request-routing system at all (the coordinator tracks node/peer liveness and capacity, but nothing submits an inference request through it — Plan 7's `/classify` gate is the first entry point built, and it isn't wired to anything downstream either). Building redundant-execution-and-compare requires that routing system first. What this plan actually builds: the **reputation ledger and ejection policy** — recording agreement/disagreement events per node, scoring them, and excluding untrusted nodes from `listActive()` — ready to be fed by a future spot-check mechanism's actual comparison results, the same way Plan 7's classifier gate was built ready for a real classifier without one being wired in yet.

**Architecture:** `ReputationTracker` (coordinator, Node.js/TypeScript) records `recordAgreement(nodeId)` / `recordDisagreement(nodeId)` events and computes a per-node trust decision from the accumulated history. `NodeRegistry.listActive()` (already the single choke point every capacity computation and routing decision reads through, per Plans 3/6) is extended to exclude nodes the tracker has marked untrusted — so ejection takes effect everywhere active-node-count is already consumed, with no changes needed anywhere else.

**Tech Stack:** Same as Plans 3/6/7 (Node.js built-ins only, zero npm dependencies).

## Global Constraints

- Everything from Plan 3/6/7's Global Constraints still applies: zero npm dependencies, no placeholders, injectable clock where relevant.
- **Trust policy, stated explicitly rather than left implicit:** a node with zero recorded checks is trusted by default (innocent until data says otherwise) — the alternative (distrust-by-default) would make every newly-registered node immediately unroutable, which defeats the point of a capacity-tracking system. This is a real, named gaming vector (a malicious node could try to avoid ever being spot-checked to stay perpetually "unproven, therefore trusted") — not silently assumed safe. Ejection requires both a minimum sample size AND a disagreement rate above threshold, so a single unlucky or malicious disagreement doesn't eject a node instantly, and the thresholds are named constants, not magic numbers, so they're easy to find and tune later.
- Reputation state is in-memory only, matching `NodeRegistry`/`PeerRegistry` (not persisted across restarts) — a restarted coordinator forgets reputation history, which is a real, disclosed limitation (a node ejected right before a restart is trusted again after one), not something this plan solves.
- No authentication on the reputation-recording endpoints (matches every other endpoint's existing no-auth, trusted-LAN scope) — an unauthenticated caller can currently record arbitrary agreement/disagreement events for any node. This is a real gap: in production, only the routing/verification system itself should be able to submit spot-check results. Named here, not solved — the same posture Plan 6 took with capacity self-reporting.

---

### Task 1: `ReputationTracker` — agreement/disagreement scoring and ejection policy

**Files:**
- Create: `coordinator/src/reputation_tracker.ts`
- Create: `coordinator/tests/reputation_tracker.test.ts`

**Interfaces:**
- Consumes: nothing (pure, no model, no I/O).
- Produces:
  ```ts
  class ReputationTracker {
    constructor(minSamples?: number, disagreementThreshold?: number);
    recordAgreement(nodeId: string): void;
    recordDisagreement(nodeId: string): void;
    isTrusted(nodeId: string): boolean;
    getStats(nodeId: string): { agreements: number; disagreements: number };
  }
  ```
  Task 2 consumes `isTrusted(nodeId)` to filter `NodeRegistry.listActive()`, and wires the two record methods to new HTTP endpoints.

- [ ] **Step 1: Write the failing tests**

Create `coordinator/tests/reputation_tracker.test.ts`:
```ts
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
```

Run:
```bash
cd coordinator && node --test tests/reputation_tracker.test.ts
```
Expected: **FAIL** — `src/reputation_tracker.ts` doesn't exist yet.

- [ ] **Step 2: Implement it**

Create `coordinator/src/reputation_tracker.ts`:
```ts
interface NodeStats {
  agreements: number;
  disagreements: number;
}

const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_DISAGREEMENT_THRESHOLD = 0.5;

export class ReputationTracker {
  private readonly minSamples: number;
  private readonly disagreementThreshold: number;
  private readonly stats = new Map<string, NodeStats>();

  constructor(
    minSamples: number = DEFAULT_MIN_SAMPLES,
    disagreementThreshold: number = DEFAULT_DISAGREEMENT_THRESHOLD,
  ) {
    this.minSamples = minSamples;
    this.disagreementThreshold = disagreementThreshold;
  }

  private getOrCreate(nodeId: string): NodeStats {
    let entry = this.stats.get(nodeId);
    if (!entry) {
      entry = { agreements: 0, disagreements: 0 };
      this.stats.set(nodeId, entry);
    }
    return entry;
  }

  recordAgreement(nodeId: string): void {
    this.getOrCreate(nodeId).agreements += 1;
  }

  recordDisagreement(nodeId: string): void {
    this.getOrCreate(nodeId).disagreements += 1;
  }

  isTrusted(nodeId: string): boolean {
    const entry = this.stats.get(nodeId);
    if (!entry) {
      return true;
    }
    const total = entry.agreements + entry.disagreements;
    if (total < this.minSamples) {
      return true;
    }
    return entry.disagreements / total < this.disagreementThreshold;
  }

  getStats(nodeId: string): NodeStats {
    const entry = this.stats.get(nodeId);
    return entry ? { ...entry } : { agreements: 0, disagreements: 0 };
  }
}
```

- [ ] **Step 3: Run the tests and verify they pass**

```bash
cd coordinator && node --test tests/reputation_tracker.test.ts
```
Expected: **PASS** — all 9 tests.

- [ ] **Step 4: Commit**

```bash
git add coordinator/src/reputation_tracker.ts coordinator/tests/reputation_tracker.test.ts
git commit -m "Add ReputationTracker: per-node agreement/disagreement scoring and ejection policy"
```

---

### Task 2: Wire reputation into node listing and expose recording endpoints

**Files:**
- Modify: `coordinator/src/registry.ts`
- Modify: `coordinator/src/server.ts`
- Modify: `coordinator/src/main.ts`
- Modify: `coordinator/tests/registry.test.ts`
- Modify: `coordinator/tests/server.test.ts`

**Interfaces:**
- Consumes: `ReputationTracker` from Task 1.
- Produces: `NodeRegistry.listActive()` gains an optional reputation filter; new endpoints:
  ```
  POST /nodes/:nodeId/reputation/agree      -> 204, or 404 if node unknown
  POST /nodes/:nodeId/reputation/disagree   -> 204, or 404 if node unknown
  GET  /nodes/:nodeId/reputation            -> { agreements, disagreements, trusted }
  ```
  `GET /nodes` and the capacity computation feeding `/catalog` now exclude untrusted nodes automatically, since both already read through `listActive()`.

- [ ] **Step 1: Write the failing tests**

Add to `coordinator/tests/registry.test.ts`. Read the current file first to confirm `NodeRegistry`'s exact current constructor/method signatures (it's been touched by Plan 3's fix rounds) before extending:

```ts
import { ReputationTracker } from "../src/reputation_tracker.ts";

test("listActive excludes a node the reputation tracker has marked untrusted", () => {
  const registry = new NodeRegistry();
  const reputation = new ReputationTracker(3, 0.5);
  const nodeId = registry.register("127.0.0.1:50052", "desktop");

  assert.equal(registry.listActive(reputation).length, 1);

  for (let i = 0; i < 3; i++) {
    reputation.recordDisagreement(nodeId);
  }
  assert.equal(registry.listActive(reputation).length, 0);
});

test("listActive without a reputation tracker argument behaves exactly as before (backward compatible)", () => {
  const registry = new NodeRegistry();
  registry.register("127.0.0.1:50052", "desktop");
  assert.equal(registry.listActive().length, 1);
});
```

Check the real current `NodeRegistry.listActive()` signature (it may or may not already take a parameter) and add an optional `reputation?: ReputationTracker` parameter that, when provided, filters out any node for which `reputation.isTrusted(nodeId)` is `false` — in addition to whatever expiry-pruning logic the method already does. The existing no-argument call sites (`server.ts`'s `GET /nodes` and the capacity aggregation) continue to work unchanged unless Task 2 Step 2 below updates them to pass the tracker.

Add to `coordinator/tests/server.test.ts` (check the current `startTestServer` helper's actual signature — it now takes catalog entries, peers, and a classifier as of Plans 6/7 — extend it to also accept an optional `ReputationTracker`, matching the established pattern of extending this one shared helper rather than writing a new one):

```ts
import { ReputationTracker } from "../src/reputation_tracker.ts";

test("POST /nodes/:nodeId/reputation/agree and /disagree record events, GET reports them", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const registerRes = await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "desktop" }),
    });
    const { nodeId } = await registerRes.json();

    await fetch(`${baseUrl}/nodes/${nodeId}/reputation/agree`, { method: "POST" });
    await fetch(`${baseUrl}/nodes/${nodeId}/reputation/agree`, { method: "POST" });
    await fetch(`${baseUrl}/nodes/${nodeId}/reputation/disagree`, { method: "POST" });

    const statsRes = await fetch(`${baseUrl}/nodes/${nodeId}/reputation`);
    assert.equal(statsRes.status, 200);
    const stats = await statsRes.json();
    assert.equal(stats.agreements, 2);
    assert.equal(stats.disagreements, 1);
    assert.equal(stats.trusted, true);
  } finally {
    server.close();
  }
});

test("reputation endpoints return 404 for an unknown nodeId", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/nodes/never-registered/reputation/agree`, { method: "POST" });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test("a node ejected by reputation disappears from GET /nodes and stops counting toward catalog capacity", async () => {
  const catalogEntries = [{ id: "small", displayName: "Small", minActiveNodes: 1 }];
  const { server, baseUrl } = await startTestServer(catalogEntries);
  try {
    const registerRes = await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "desktop" }),
    });
    const { nodeId } = await registerRes.json();

    const beforeCatalog = await (await fetch(`${baseUrl}/catalog`)).json();
    assert.equal(beforeCatalog.find((e: any) => e.id === "small").available, true);

    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/nodes/${nodeId}/reputation/disagree`, { method: "POST" });
    }

    const nodesRes = await fetch(`${baseUrl}/nodes`);
    assert.equal((await nodesRes.json()).length, 0);

    const afterCatalog = await (await fetch(`${baseUrl}/catalog`)).json();
    assert.equal(afterCatalog.find((e: any) => e.id === "small").available, false);
  } finally {
    server.close();
  }
});
```

Run:
```bash
cd coordinator && npm test
```
Expected: **FAIL** — `listActive` doesn't accept a reputation argument yet, the new endpoints don't exist.

- [ ] **Step 2: Implement**

Modify `coordinator/src/registry.ts`'s `listActive()` to accept an optional `ReputationTracker` and filter by it (add `import { ReputationTracker } from "./reputation_tracker.ts";` at the top). Check the real current method body before editing — add the reputation check alongside whatever expiry logic already exists, filtering out any node where `reputation && !reputation.isTrusted(node.nodeId)`.

Modify `coordinator/src/server.ts`: add the `ReputationTracker` import and a new `createServer` parameter, then add the three new routes (following the existing routing pattern) plus update `GET /nodes` and the capacity-aggregation function to pass the tracker into `listActive()`:

```ts
if (method === "POST" && parts[0] === "nodes" && parts.length === 4 && parts[2] === "reputation" &&
    (parts[3] === "agree" || parts[3] === "disagree")) {
  const exists = registry.listActive().some(n => n.nodeId === parts[1]) ||
                 registry.listActive(reputation).some(n => n.nodeId === parts[1]);
  // A node can be temporarily un-trusted (excluded from listActive with
  // reputation applied) but still a real, known node -- recording a further
  // event for it must still work, so check node existence via the
  // reputation-unfiltered view, not the filtered one.
  if (!exists) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (parts[3] === "agree") {
    reputation.recordAgreement(parts[1]);
  } else {
    reputation.recordDisagreement(parts[1]);
  }
  res.writeHead(204);
  res.end();
  return;
}

if (method === "GET" && parts[0] === "nodes" && parts.length === 3 && parts[2] === "reputation") {
  const exists = registry.listActive().some(n => n.nodeId === parts[1]);
  if (!exists) {
    res.writeHead(404);
    res.end();
    return;
  }
  const stats = reputation.getStats(parts[1]);
  sendJson(res, 200, { ...stats, trusted: reputation.isTrusted(parts[1]) });
  return;
}
```

Adjust the existing `GET /nodes` route and the capacity-aggregation function to call `registry.listActive(reputation)` instead of the bare `registry.listActive()`, so ejected nodes disappear from both.

Note the existence check above deliberately uses the UNFILTERED `listActive()` (no reputation argument) — a node whose reputation has already dropped below the trust threshold must still exist as a real registered node for the `/reputation` endpoints themselves to operate on; only capacity-facing views (`GET /nodes` without the reputation query, `/catalog`) should apply the filter. Verify this reasoning holds by re-reading the two tests above closely before implementing, and adjust the exact route logic if a cleaner formulation occurs to you — the tested BEHAVIOR (existence checks succeed for a since-ejected node; `GET /nodes` and `/catalog` exclude it) is what matters, not this exact code shape.

- [ ] **Step 3: Update `main.ts`**

```ts
import { ReputationTracker } from "./reputation_tracker.ts";
// ...
const reputation = new ReputationTracker();
const server = createServer(registry, catalog, peers, classifier, reputation);
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd coordinator && npm test
```
Expected: **PASS** — full suite, including all new tests.

- [ ] **Step 5: Commit**

```bash
git add coordinator/src/registry.ts coordinator/src/server.ts coordinator/src/main.ts coordinator/tests/registry.test.ts coordinator/tests/server.test.ts
git commit -m "Wire ReputationTracker into node listing and expose spot-check recording endpoints"
```

---

## What this plan does not do

Does not implement the actual redundant-computation spot-check mechanism (running the same request on two nodes and comparing outputs) — that requires a request-routing system this repo doesn't have yet (see the Scope Correction above). Does not persist reputation history across coordinator restarts. Does not authenticate the reputation-recording endpoints — matches every other endpoint's existing no-auth scope, but is a real, named gap: currently any caller can record arbitrary agreement/disagreement events for any node.
