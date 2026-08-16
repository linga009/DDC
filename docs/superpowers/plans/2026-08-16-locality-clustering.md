# Locality-Aware Node Clustering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the coordinator a way to group its registered nodes by physical/network locality, so a future pipeline-assembly system can honor the spec's stated preference ("the coordinator prefers assembling pipelines from devices on the same local mesh") instead of treating every node as equally distant.

**Scope correction, stated up front:** the spec's Local Mesh Layer describes WiFi Direct / Multipeer Connectivity / local LAN *discovery* — client-device code that detects nearby peers over a local radio or LAN broadcast. That discovery code doesn't exist in this repo: it's a per-platform client capability (Android/iOS/desktop), not yet built (client apps are a later, undesigned plan). The spec's Locality Clustering description is a *pipeline-assembly* behavior — but there is no pipeline-assembly or request-routing system in this repo at all yet (Plan 8 already documented this gap; nothing has changed since). This plan can build neither of those. What it actually builds: a **locality-group data model and grouping query** on the coordinator side — nodes can optionally self-report a locality-group identifier at registration (a string a client's future mesh-discovery code would generate, e.g. from a local session ID or LAN identifier), and the coordinator can group its active nodes by that identifier. This is groundwork, the same way Plan 7 built a classifier gate with no real classifier wired in and Plan 8 built a reputation ledger with no real spot-check mechanism feeding it: a future pipeline assembler consumes this grouping to prefer same-group nodes, and a future client mesh-discovery layer produces the group identifiers. Neither exists yet.

**Architecture:** `NodeRegistry` (already the single choke point for node state, per Plans 3/6/8) gains an optional `localityGroup` field on registration and a `groupByLocality()` method built on top of the existing `listActive()` (so it inherits expiry-pruning and reputation-filtering for free, with no duplicated logic). `coordinator/src/server.ts` exposes the field on `POST /nodes/register` and adds one new read endpoint, `GET /nodes/locality`, following the exact routing pattern established by every endpoint added in Plans 3/6/7/8.

**Tech Stack:** Same as Plans 3/6/7/8 (Node.js built-ins only, zero npm dependencies).

## Global Constraints

- Everything from Plan 3/6/7/8's Global Constraints still applies: zero npm dependencies, no placeholders, injectable clock where relevant, in-memory only (no persistence across restarts).
- **Locality is self-reported and unverified — a named gaming vector, not silently assumed safe.** A client supplies its own `localityGroup` string at registration; the coordinator does not verify physical or network proximity in any way (that would require the real mesh-discovery/cryptographic-attestation layer this plan explicitly does not build). A malicious or misconfigured node can claim any group string, including one matching a specific victim deployment, to get preferentially clustered alongside targeted nodes once a future pipeline assembler starts using this grouping to route requests. This is disclosed in the README next to the existing no-auth caveats, not solved here — the same posture Plan 6 took with capacity self-reporting and Plan 8 took with reputation-recording endpoints.
- `localityGroup` is optional. A node that omits it is grouped under a named constant (`UNGROUPED_LOCALITY = "ungrouped"`), not silently dropped from grouping results — omitting locality must never make a node harder to find than supplying one.
- No authentication on the new endpoint or the new registration field (matches every other endpoint's existing no-auth, trusted-LAN scope).

---

### Task 1: `NodeRegistry` — locality field and grouping query

**Files:**
- Modify: `coordinator/src/registry.ts`
- Modify: `coordinator/tests/registry.test.ts`

**Interfaces:**
- Consumes: nothing new — extends the existing `NodeRegistry` class from Plans 3/6/8.
- Produces:
  ```ts
  export const UNGROUPED_LOCALITY = "ungrouped";

  interface NodeInfo {
    nodeId: string;
    endpoint: string;
    deviceTier: DeviceTier;
    localityGroup?: string;   // NEW
  }

  class NodeRegistry {
    register(endpoint: string, deviceTier: DeviceTier, localityGroup?: string): string;  // localityGroup param NEW
    groupByLocality(reputation?: ReputationTracker): Map<string, NodeInfo[]>;  // NEW
    // heartbeat(), listActive(), size() unchanged in signature
  }
  ```
  Task 2 consumes `register()`'s new third parameter and `groupByLocality()` to build the HTTP layer.

- [ ] **Step 1: Write the failing tests**

Read `coordinator/src/registry.ts` and `coordinator/tests/registry.test.ts` in full first — Plan 8 added a `reputation?: ReputationTracker` parameter to `listActive()`, confirm the exact current signature before extending `register()` and adding `groupByLocality()` alongside it.

Add to `coordinator/tests/registry.test.ts`:

```ts
import { NodeRegistry, UNGROUPED_LOCALITY } from "../src/registry.ts";

test("register accepts an optional localityGroup and it is returned via listActive", () => {
  const registry = new NodeRegistry();
  registry.register("127.0.0.1:50052", "desktop", "kitchen-mesh");
  const [node] = registry.listActive();
  assert.equal(node.localityGroup, "kitchen-mesh");
});

test("register without a localityGroup leaves it undefined via listActive", () => {
  const registry = new NodeRegistry();
  registry.register("127.0.0.1:50052", "desktop");
  const [node] = registry.listActive();
  assert.equal(node.localityGroup, undefined);
});

test("groupByLocality groups nodes that share the same localityGroup together", () => {
  const registry = new NodeRegistry();
  registry.register("127.0.0.1:50052", "desktop", "kitchen-mesh");
  registry.register("127.0.0.1:50053", "android", "kitchen-mesh");
  registry.register("127.0.0.1:50054", "desktop", "office-mesh");

  const groups = registry.groupByLocality();

  assert.equal(groups.get("kitchen-mesh")?.length, 2);
  assert.equal(groups.get("office-mesh")?.length, 1);
});

test("groupByLocality buckets nodes with no localityGroup under UNGROUPED_LOCALITY", () => {
  const registry = new NodeRegistry();
  registry.register("127.0.0.1:50052", "desktop");

  const groups = registry.groupByLocality();

  assert.equal(groups.get(UNGROUPED_LOCALITY)?.length, 1);
});

test("groupByLocality excludes a node the reputation tracker has marked untrusted", () => {
  const registry = new NodeRegistry();
  const reputation = new ReputationTracker(3, 0.5);
  const nodeId = registry.register("127.0.0.1:50052", "desktop", "kitchen-mesh");

  assert.equal(registry.groupByLocality(reputation).get("kitchen-mesh")?.length, 1);

  for (let i = 0; i < 3; i++) {
    reputation.recordDisagreement(nodeId);
  }
  assert.equal(registry.groupByLocality(reputation).has("kitchen-mesh"), false);
});

test("groupByLocality excludes an expired node, matching listActive's pruning", () => {
  let now = 1000;
  const registry = new NodeRegistry(() => now, 30000);
  registry.register("127.0.0.1:50052", "desktop", "kitchen-mesh");

  now += 30001;
  const groups = registry.groupByLocality();

  assert.equal(groups.has("kitchen-mesh"), false);
});
```

Add the `ReputationTracker` import needed by the fifth test (check the top of the file — Plan 8's tests already import it; reuse that same import rather than adding a duplicate).

Run:
```bash
cd coordinator && npm test
```
Expected: **FAIL** — `register` doesn't accept a third argument's effect isn't observable yet (it's silently ignored by TypeScript's structural typing unless you add the field, so the FIRST two tests fail on the `localityGroup` assertion, not a type error), and `groupByLocality` / `UNGROUPED_LOCALITY` don't exist yet (`TypeError: registry.groupByLocality is not a function` / import error).

- [ ] **Step 2: Implement**

Modify `coordinator/src/registry.ts`:

1. Add `export const UNGROUPED_LOCALITY = "ungrouped";` near the top of the file.
2. Add `localityGroup?: string;` to the `NodeInfo` interface.
3. Change `register()`'s signature to `register(endpoint: string, deviceTier: DeviceTier, localityGroup?: string): string` and include `localityGroup` in the stored node object.
4. In `listActive()`, include `localityGroup: node.localityGroup` in each pushed `NodeInfo` (an `undefined` value is fine — `JSON.stringify` drops `undefined` properties automatically, matching how the rest of this API already behaves for optional fields).
5. Add the new method, built on `listActive()` so it inherits pruning and reputation-filtering with no duplicated logic:

```ts
groupByLocality(reputation?: ReputationTracker): Map<string, NodeInfo[]> {
  const groups = new Map<string, NodeInfo[]>();
  for (const node of this.listActive(reputation)) {
    const key = node.localityGroup ?? UNGROUPED_LOCALITY;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(node);
    } else {
      groups.set(key, [node]);
    }
  }
  return groups;
}
```

- [ ] **Step 3: Run the tests and verify they pass**

```bash
cd coordinator && npm test
```
Expected: **PASS** — full suite, including all 6 new tests.

- [ ] **Step 4: Commit**

```bash
git add coordinator/src/registry.ts coordinator/tests/registry.test.ts
git commit -m "Add locality-group field and grouping query to NodeRegistry"
```

---

### Task 2: Expose locality on registration and add `GET /nodes/locality`

**Files:**
- Modify: `coordinator/src/server.ts`
- Modify: `coordinator/tests/server.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `NodeRegistry.register()`'s new third parameter and `groupByLocality()` from Task 1.
- Produces: `POST /nodes/register` accepts an optional `"localityGroup"` string field in its JSON body; new endpoint:
  ```
  GET /nodes/locality -> 200, { [group: string]: NodeInfo[] }
  ```

- [ ] **Step 1: Write the failing tests**

Read `coordinator/src/server.ts` in full first — confirm the exact current `POST /nodes/register` validation block and routing structure (Plan 8 added routes after it; match that established pattern for the new route).

Add to `coordinator/tests/server.test.ts` (check the current `startTestServer` helper's actual signature before writing — reuse it rather than writing a new one, matching the established pattern from every prior plan):

```ts
test("POST /nodes/register accepts an optional localityGroup and it is echoed back via GET /nodes", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const registerRes = await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "desktop", localityGroup: "kitchen-mesh" }),
    });
    assert.equal(registerRes.status, 200);

    const nodes = await (await fetch(`${baseUrl}/nodes`)).json();
    assert.equal(nodes[0].localityGroup, "kitchen-mesh");
  } finally {
    server.close();
  }
});

test("POST /nodes/register rejects a non-string localityGroup", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "desktop", localityGroup: 42 }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("POST /nodes/register rejects an empty-string localityGroup", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const res = await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "desktop", localityGroup: "" }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test("GET /nodes/locality groups registered nodes by their localityGroup, with ungrouped nodes bucketed separately", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "desktop", localityGroup: "kitchen-mesh" }),
    });
    await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50053", deviceTier: "android" }),
    });

    const res = await fetch(`${baseUrl}/nodes/locality`);
    assert.equal(res.status, 200);
    const groups = await res.json();
    assert.equal(groups["kitchen-mesh"].length, 1);
    assert.equal(groups["ungrouped"].length, 1);
  } finally {
    server.close();
  }
});

test("GET /nodes/locality excludes a node ejected by reputation", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const registerRes = await fetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "127.0.0.1:50052", deviceTier: "desktop", localityGroup: "kitchen-mesh" }),
    });
    const { nodeId } = await registerRes.json();

    for (let i = 0; i < 5; i++) {
      await fetch(`${baseUrl}/nodes/${nodeId}/reputation/disagree`, { method: "POST" });
    }

    const groups = await (await fetch(`${baseUrl}/nodes/locality`)).json();
    assert.equal(groups["kitchen-mesh"], undefined);
  } finally {
    server.close();
  }
});
```

Run:
```bash
cd coordinator && npm test
```
Expected: **FAIL** — `localityGroup` isn't accepted or validated yet, `GET /nodes/locality` doesn't exist (404).

- [ ] **Step 2: Implement**

Modify `coordinator/src/server.ts`'s `POST /nodes/register` handler: after the existing `deviceTier` validation, add:

```ts
let localityGroup: string | undefined;
if (candidate.localityGroup !== undefined) {
  if (typeof candidate.localityGroup !== "string" || candidate.localityGroup.length === 0) {
    sendJson(res, 400, { error: "localityGroup must be a non-empty string when provided" });
    return;
  }
  localityGroup = candidate.localityGroup;
}
const nodeId = registry.register(candidate.endpoint, candidate.deviceTier as DeviceTier, localityGroup);
```

(This replaces the existing single-line `registry.register(candidate.endpoint, candidate.deviceTier as DeviceTier)` call — check the exact current line before editing, since Plan 8 may have touched neighboring lines.)

Add a new route, following the established pattern (e.g. placed near the other `GET /nodes*` routes):

```ts
if (method === "GET" && parts[0] === "nodes" && parts.length === 2 && parts[1] === "locality") {
  const groups = registry.groupByLocality(reputation);
  const asObject: Record<string, unknown> = {};
  for (const [key, nodes] of groups) {
    asObject[key] = nodes;
  }
  sendJson(res, 200, asObject);
  return;
}
```

> **Correction found during Task 2's review (2026-08-16):** the manual-loop
> snippet above has a `__proto__`-key prototype-pollution bug — a
> self-reported `localityGroup` of `"__proto__"` would hit
> `asObject["__proto__"] = nodes`, which assigns through `Object.prototype`'s
> setter instead of creating an own property. The actual implementation
> deviates from this snippet and uses `const asObject =
> Object.fromEntries(groups);` instead, which assigns `__proto__` as a
> plain own key. See commit `7060b00`.

Place this check so it does not shadow or get shadowed by the existing bare `GET /nodes` route (`parts.length === 1`) — the two have different `parts.length`, so ordering relative to each other doesn't matter, but confirm no other `parts[0] === "nodes"` route also matches `parts.length === 2 && parts[1] === "locality"` before adding it.

- [ ] **Step 3: Update README**

Add `GET /nodes/locality` to the coordinator's endpoint list in `README.md`, and document the optional `localityGroup` field on `POST /nodes/register`. Add a short note — matching the tone of the existing "Known gaming vectors" section Plan 8 added — that locality is self-reported and unverified: a node can claim any group string, and the coordinator does not verify physical or network proximity. State plainly that no pipeline-assembly system yet consumes this grouping and no client-side mesh-discovery code yet produces real locality identifiers — this endpoint exists so both can be built against a stable interface later.

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd coordinator && npm test
```
Expected: **PASS** — full suite, including all 5 new tests.

- [ ] **Step 5: Commit**

```bash
git add coordinator/src/server.ts coordinator/tests/server.test.ts README.md
git commit -m "Expose locality grouping via POST /nodes/register and GET /nodes/locality"
```

---

## What this plan does not do

Does not implement real local-mesh discovery (WiFi Direct / Multipeer Connectivity / LAN broadcast) — that is client-device code for a future, undesigned client-apps plan. Does not implement pipeline assembly or request routing of any kind — no such system exists in this repo yet (Plan 8 already documented this gap). Does not verify that a node's self-reported `localityGroup` reflects real physical or network proximity — a named, disclosed gaming vector. Does not persist locality data across coordinator restarts (in-memory only, matching every other piece of state in this service).
