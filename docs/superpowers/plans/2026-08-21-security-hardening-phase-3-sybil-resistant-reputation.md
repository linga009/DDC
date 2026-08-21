# Security Hardening Phase 3: Sybil-Resistant Reputation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a node's identity in `NodeRegistry` stable across
re-registration, closing the live-verified "re-register to clear
reputation," "go quiet past the 30s heartbeat timeout then come back
clean," and "one endpoint occupies several `localityGroup`s at once"
vectors documented in README's "Known gaming vectors" section.

**Architecture:** `NodeRegistry.register()` (`coordinator/src/registry.ts`)
changes from minting a random `nodeId` (`randomUUID()`) to deriving one
deterministically from the endpoint (`sha256` hex digest, lowercased
first). `this.nodes` is already a `Map<string, StoredNode>` keyed by
`nodeId` — once `nodeId` is a pure function of `endpoint`, `Map.set()`
on a repeat registration for the same endpoint always overwrites the same
key, whether or not the previous entry is still live, already expired, or
already pruned out of the map. `ReputationTracker` needs **zero changes**
— it already keys its stats by whatever `nodeId` string it's handed, so a
stable `nodeId` makes reputation history durable across re-registration
for free.

**Tech Stack:** Coordinator: Node.js native TypeScript, `node:crypto`,
`node:test`. No new dependencies.

## Global Constraints

- **Never add a `Co-Authored-By: Claude` trailer to any commit.** State
  this in every dispatch — it does not carry over automatically.
- Coordinator: zero npm dependencies. Only `node:http`, `node:test`,
  `node:assert/strict`, `node:crypto`, `node:fs`, `node:os`, `node:path`,
  native `fetch`, `AbortSignal.timeout`, etc.
- `ReputationTracker` (`coordinator/src/reputation_tracker.ts`) is **not
  modified** by this plan. It already accepts an arbitrary `nodeId: string`
  key with no assumption about its format or origin.
- `server.ts`'s `/nodes/register` handler already normalizes the endpoint
  it hands to `registry.register()` (`new URL(candidate.endpoint).href`
  with the trailing slash stripped) before this plan's code ever sees it —
  this plan's `.toLowerCase()` inside `NodeRegistry` is defense-in-depth
  for any other caller (including this repo's own unit tests, which call
  `register()` directly with bare strings like `"127.0.0.1:50052"`, no URL
  parsing involved), not the primary normalization boundary.
- Run coordinator tests: `cd coordinator && npm test`.
- This plan runs in its own git worktree at
  `.worktrees/security-phase-3-sybil-resistant-reputation` (branch
  `security-phase-3-sybil-resistant-reputation`), created via the
  `using-git-worktrees` skill before Task 1 starts, off `master`.

---

### Task 1: Deterministic endpoint-derived `nodeId` in `NodeRegistry`

**Files:**
- Modify: `coordinator/src/registry.ts`
- Test: `coordinator/tests/registry.test.ts`

**Interfaces:**
- Consumes: `node:crypto`'s `createHash` (stdlib).
- Produces: `NodeRegistry.register(endpoint: string, deviceTier: DeviceTier, localityGroup?: string, servesModel?: string): string` — **signature
  unchanged**, but the returned `nodeId` is now a deterministic 64-character
  lowercase hex string (`sha256` of the lowercased endpoint) instead of a
  random UUID, and is identical across repeated calls with the same
  endpoint. Task 2 depends on exactly this property (a second
  `POST /nodes/register` call for an already-known endpoint returns the
  same `nodeId` as the first).

- [ ] **Step 1: Write the failing tests**

Append these tests to the end of `coordinator/tests/registry.test.ts`
(the file already imports `test`, `assert`, `NodeRegistry`,
`UNGROUPED_LOCALITY`, and `ReputationTracker` — no new imports needed):

```typescript
test("register called twice with the same endpoint returns the same nodeId and does not grow size()", () => {
  const registry = new NodeRegistry();
  const first = registry.register("http://127.0.0.1:50052", "desktop");
  const second = registry.register("http://127.0.0.1:50052", "desktop");

  assert.equal(first, second);
  assert.equal(registry.size(), 1);
});

test("nodeId is a 64-character lowercase hex string (sha256 of the endpoint), not a UUID", () => {
  const registry = new NodeRegistry();
  const nodeId = registry.register("http://127.0.0.1:50052", "desktop");

  assert.match(nodeId, /^[0-9a-f]{64}$/);
});

test("re-registering the same endpoint with a different deviceTier/localityGroup/servesModel updates the fields in place under the same nodeId", () => {
  const registry = new NodeRegistry();
  const first = registry.register("http://127.0.0.1:50052", "desktop", "kitchen-mesh", "tinyllama-1.1b");
  const second = registry.register("http://127.0.0.1:50052", "android", "office-mesh", "small-7b");

  assert.equal(first, second);
  assert.equal(registry.size(), 1);
  const [node] = registry.listActive();
  assert.equal(node.deviceTier, "android");
  assert.equal(node.localityGroup, "office-mesh");
  assert.equal(node.servesModel, "small-7b");
});

test("registering the same endpoint under three different localityGroup values in sequence never produces more than one active node at a time", () => {
  const registry = new NodeRegistry();
  registry.register("http://127.0.0.1:50052", "desktop", "kitchen-mesh");
  registry.register("http://127.0.0.1:50052", "desktop", "office-mesh");
  registry.register("http://127.0.0.1:50052", "desktop", "garage-mesh");

  assert.equal(registry.size(), 1);
  const groups = registry.groupByLocality();
  assert.equal(groups.has("kitchen-mesh"), false);
  assert.equal(groups.has("office-mesh"), false);
  assert.equal(groups.get("garage-mesh")?.length, 1);
});

test("nodeId derivation is case-insensitive in the endpoint", () => {
  const registry = new NodeRegistry();
  const lower = registry.register("http://127.0.0.1:50052", "desktop");
  const upper = registry.register("HTTP://127.0.0.1:50052", "desktop");

  assert.equal(lower, upper);
  assert.equal(registry.size(), 1);
});

test("two different endpoints still produce two different nodeIds", () => {
  const registry = new NodeRegistry();
  const a = registry.register("http://127.0.0.1:50052", "desktop");
  const b = registry.register("http://127.0.0.1:50053", "desktop");

  assert.notEqual(a, b);
});

test("a node's reputation survives an expire-then-re-register cycle at the same endpoint", () => {
  let now = 0;
  const registry = new NodeRegistry(() => now);
  const reputation = new ReputationTracker(3, 0.5);

  const firstId = registry.register("http://127.0.0.1:50052", "desktop");
  for (let i = 0; i < 3; i++) {
    reputation.recordDisagreement(firstId);
  }
  assert.equal(reputation.isTrusted(firstId), false);

  now = 30001; // past the 30s timeout, with no heartbeat in between
  assert.equal(registry.listActive(reputation).length, 0); // pruned from the registry
  assert.equal(registry.size(), 0);

  const secondId = registry.register("http://127.0.0.1:50052", "desktop"); // re-register, same endpoint

  assert.equal(secondId, firstId);
  assert.equal(reputation.isTrusted(secondId), false); // still untrusted -- history was never reset
  assert.deepEqual(reputation.getStats(secondId), { agreements: 0, disagreements: 3 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd coordinator && npm test -- --test-name-pattern="same nodeId|64-character|updates the fields in place|three different localityGroup|case-insensitive|two different endpoints still|expire-then-re-register"`
Expected: FAIL — the first several tests fail because `register()` still
returns a random `randomUUID()` each call (so `assert.equal(first, second)`
fails, and the hex-shape test fails against a UUID's dashed format).

- [ ] **Step 3: Write minimal implementation**

Replace the full contents of `coordinator/src/registry.ts` with:

```typescript
import { createHash } from "node:crypto";
import type { ReputationTracker } from "./reputation_tracker.ts";

export type DeviceTier = "desktop" | "android" | "ios";

export const UNGROUPED_LOCALITY = "ungrouped";

export interface NodeInfo {
  nodeId: string;
  endpoint: string;
  deviceTier: DeviceTier;
  localityGroup?: string;
  servesModel?: string;
}

interface StoredNode extends NodeInfo {
  lastSeen: number;
}

function stableNodeId(endpoint: string): string {
  // Deterministic, not random: the same endpoint must always produce the
  // same nodeId, no matter how many times or how far apart in time it
  // registers. This is what makes a re-registration below overwrite (not
  // duplicate) the existing Map entry, closing the "re-register to clear
  // reputation" and "go quiet 30s then reset" evasions -- identity here
  // never depends on any prior entry still being present in `nodes`,
  // unlike a live scan for a matching endpoint (PeerRegistry's approach)
  // would.
  return createHash("sha256").update(endpoint.toLowerCase()).digest("hex");
}

export class NodeRegistry {
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly nodes = new Map<string, StoredNode>();

  constructor(clock: () => number = Date.now, timeoutMs = 30000) {
    this.clock = clock;
    this.timeoutMs = timeoutMs;
  }

  register(endpoint: string, deviceTier: DeviceTier, localityGroup?: string, servesModel?: string): string {
    const nodeId = stableNodeId(endpoint);
    this.nodes.set(nodeId, { nodeId, endpoint, deviceTier, localityGroup, servesModel, lastSeen: this.clock() });
    return nodeId;
  }

  heartbeat(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) {
      return false;
    }
    const now = this.clock();
    if (now - node.lastSeen > this.timeoutMs) {
      // Already past the timeout -- treat this like an unknown node rather
      // than reviving it. Otherwise heartbeat's result for a stale node
      // would depend on whether some unrelated listActive() call happened
      // to have scanned-and-pruned it first, which is a nondeterministic
      // contract driven entirely by incidental traffic. Past-timeout now
      // unconditionally means heartbeat() returns false.
      this.nodes.delete(nodeId);
      return false;
    }
    node.lastSeen = now;
    return true;
  }

  listActive(reputation?: ReputationTracker): NodeInfo[] {
    const now = this.clock();
    const active: NodeInfo[] = [];
    for (const [nodeId, node] of this.nodes) {
      if (now - node.lastSeen <= this.timeoutMs) {
        if (reputation && !reputation.isTrusted(node.nodeId)) {
          continue;
        }
        active.push({ nodeId: node.nodeId, endpoint: node.endpoint, deviceTier: node.deviceTier, localityGroup: node.localityGroup, servesModel: node.servesModel });
      } else {
        // Expired -- prune it here rather than just leaving it out of the
        // result, so long-running processes don't accumulate dead entries.
        this.nodes.delete(nodeId);
      }
    }
    return active;
  }

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

  size(): number {
    return this.nodes.size;
  }
}
```

The only real changes from the current file: the `randomUUID` import is
replaced with `createHash`, a new module-level `stableNodeId()` helper is
added, and `register()`'s first line changes from
`const nodeId = randomUUID();` to `const nodeId = stableNodeId(endpoint);`.
`heartbeat`, `listActive`, `groupByLocality`, and `size` are byte-for-byte
unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd coordinator && npm test -- --test-name-pattern="same nodeId|64-character|updates the fields in place|three different localityGroup|case-insensitive|two different endpoints still|expire-then-re-register"`
Expected: PASS (all new tests green).

- [ ] **Step 5: Run the full suite to check for regressions**

Run: `cd coordinator && npm test`
Expected: PASS — all pre-existing `registry.test.ts` tests (none of them
register the same endpoint twice expecting two distinct entries, so none
should need changes) plus every other existing coordinator test, plus the
new tests from this task.

- [ ] **Step 6: Commit**

```bash
git add coordinator/src/registry.ts coordinator/tests/registry.test.ts
git commit -m "Derive NodeRegistry nodeId deterministically from endpoint, not randomly"
```

---

### Task 2: HTTP-level regression coverage and documentation

**Files:**
- Modify: `coordinator/tests/server.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `NodeRegistry.register()`'s new deterministic behavior from
  Task 1, exercised only indirectly through the real HTTP server (this
  task never imports `registry.ts` directly).
- Produces: nothing consumed by a later task — this is the last task in
  this plan.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `coordinator/tests/server.test.ts`, directly after
the existing test `"a node ejected by reputation disappears from GET
/nodes and stops counting toward catalog capacity"` (this file already
imports everything needed and already defines `startTestServer` and
`authFetch` — no new imports needed):

```typescript
test("a node ejected by reputation stays ejected after re-registering the same endpoint -- reputation is not reset by churn", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const registerRes = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop" }),
    });
    const { nodeId: firstNodeId } = await registerRes.json();

    for (let i = 0; i < 5; i++) {
      await authFetch(`${baseUrl}/nodes/${firstNodeId}/reputation/disagree`, { method: "POST" });
    }

    const ejectedNodes = await (await authFetch(`${baseUrl}/nodes`)).json();
    assert.equal(ejectedNodes.length, 0);

    // Re-register the exact same endpoint -- this is the live-verified
    // vector from README's "Known gaming vectors" section: before this
    // plan, this returned a brand-new randomUUID() nodeId with a clean
    // reputation record, restoring the node to GET /nodes immediately.
    const reregisterRes = await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop" }),
    });
    const { nodeId: secondNodeId } = await reregisterRes.json();

    assert.equal(secondNodeId, firstNodeId);

    const stillEjectedNodes = await (await authFetch(`${baseUrl}/nodes`)).json();
    assert.equal(stillEjectedNodes.length, 0);

    const statsRes = await authFetch(`${baseUrl}/nodes/${secondNodeId}/reputation`);
    assert.deepEqual(await statsRes.json(), { agreements: 0, disagreements: 5, trusted: false });
  } finally {
    server.close();
  }
});

test("registering the same endpoint under three different localityGroup values never shows more than one node in GET /nodes/locality", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    for (const group of ["kitchen-mesh", "office-mesh", "garage-mesh"]) {
      await authFetch(`${baseUrl}/nodes/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: "http://127.0.0.1:50052", deviceTier: "desktop", localityGroup: group }),
      });
    }

    const localityRes = await authFetch(`${baseUrl}/nodes/locality`);
    const groups = await localityRes.json();

    assert.equal(groups["kitchen-mesh"], undefined);
    assert.equal(groups["office-mesh"], undefined);
    assert.equal(groups["garage-mesh"].length, 1);

    const nodesRes = await authFetch(`${baseUrl}/nodes`);
    assert.equal((await nodesRes.json()).length, 1);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run the new tests**

Run: `cd coordinator && npm test -- --test-name-pattern="stays ejected after re-registering|never shows more than one node"`
Expected: PASS immediately. This deliberately skips the usual red-then-green
sequence: Task 1's fix is already committed earlier on this same branch, so
there is no "before the fix" state left to observe from here — these two
tests exercise the fix at the HTTP layer, they don't introduce it. Confirm
they're asserting real, specific behavior (not vacuously true) by reading
each assertion against the endpoint used: `firstNodeId`/`secondNodeId`
must be the literal same string, and the locality test's three groups must
each be checked, not just the last one.

- [ ] **Step 3: Run the full suite to confirm no regressions**

Run: `cd coordinator && npm test`
Expected: PASS — all tests, including the two new ones.

- [ ] **Step 4: Update README's "Known gaming vectors" paragraph**

Find this text in `README.md` (in the reputation/ejection section):

```markdown
**Known gaming vectors:** reputation is keyed by `nodeId`, and
`NodeRegistry.register()` mints a fresh `randomUUID()` on every call with no
endpoint dedupe (unlike `PeerRegistry`, which dedupes registrations by
endpoint) — so an ejected node clears its record with one more
`POST /nodes/register` call, restoring its `/capacity` count immediately.
Verified live: 5 disagreements ejects a node; one re-register call and
it's back with a clean slate. This is a stronger, cheaper vector than a
node simply avoiding ever being spot-checked to stay perpetually
"unproven, therefore trusted" under the zero-checks-trusted default above.
Since `POST /generate` now exists, ejecting a legitimate node this way is
no longer just about restoring a `/capacity` count: verified live, an
attacker who has separately registered their own endpoint with a
`servesModel` matching the ejected node's model becomes the sole remaining
match for that model, so every subsequent `/generate` call for it —
including real user prompts — gets routed to the attacker's node, which can
return arbitrary attacker-controlled text as if it were the real model's
output. That same routing step also hands the attacker the swarm's shared
secret: the coordinator authenticates its outbound `/complete` call with
`Authorization: Bearer <the-shared-token>`, so registering an endpoint you
control is enough to capture the token in cleartext (verified live — see
the Authentication section above). Registering requires already holding
the token, so this is a token-holder vector rather than an outsider one,
but it means the secret spreads to every endpoint anyone ever registers
and cannot be un-learned by a node operator who later leaves. Separately, the disagreement ratio is all-time with no decay or windowing,
so an established node with a long good history (e.g. 200 agreements)
needs 200 *consecutive* disagreements to be ejected — the inverse of
catching a node that goes bad (compromised, degraded hardware) after
building trust, and effectively un-ejectable at any realistic spot-check
sampling rate. Fixing the first requires stable node identity
(endpoint-keyed or node-supplied public key); fixing the second requires a
sliding window or EWMA scoring function instead of a lifetime ratio. Both
are out of scope for this ledger-only plan and are prerequisites for the
future spot-check-mechanism plan. Note also that because every
registration mints a fresh reputation entry with no eviction, a churning
fleet leaks one entry per registration in the in-memory `Map` — the same
stable-identity fix needed above would address this too; evicting on
registry-prune alone is not attempted here, since it would open a new
evasion path (go quiet for 30s to get a clean slate).
```

Replace it with:

```markdown
**Known gaming vectors:** reputation is keyed by `nodeId`. **Fixed in
Security Hardening Phase 3:** `NodeRegistry.register()` used to mint a
fresh `randomUUID()` on every call with no endpoint dedupe, so an ejected
node could clear its record with one more `POST /nodes/register` call —
verified live: 5 disagreements ejected a node, one re-register call
restored it with a clean slate, and (once `POST /generate` existed) that
clean-slate node could go on to capture real user traffic for a model and
the swarm's shared token in cleartext (registering an endpoint you control
is enough to capture `SWARM_AUTH_TOKEN`, since the coordinator
authenticates its outbound `/complete` call with it). `nodeId` is now a
deterministic `sha256` hash of the (lowercased) endpoint rather than a
random value, so `Map.set()` naturally overwrites the same entry on every
re-registration of the same endpoint, no matter how much time has passed
or whether the previous entry already aged out of the registry — a node
cannot shed reputation history by re-registering, and cannot escape it by
going quiet past the 30-second heartbeat timeout and coming back either.
Verified live: eject a node with 5 disagreements, re-register the same
endpoint, `GET /nodes` still excludes it and `GET /nodes/:nodeId/reputation`
still reports the same `nodeId` with its disagreement count intact.
**Not fixed by this:** an attacker who holds `SWARM_AUTH_TOKEN` can still
mint unlimited *distinct* identities by registering different endpoints
(e.g. several ports on one machine) — Phase 3 makes a given endpoint's
identity stable and non-resettable, it does not limit how many endpoints
one attacker can register in the first place. Separately, the disagreement
ratio is still all-time with no decay or windowing, so an established node
with a long good history (e.g. 200 agreements) still needs 200
*consecutive* disagreements to be ejected — the inverse of catching a node
that goes bad (compromised, degraded hardware) after building trust, and
effectively un-ejectable at any realistic spot-check sampling rate. Fixing
this requires a sliding window or EWMA scoring function instead of a
lifetime ratio, and remains unscoped and undesigned (see the Security
Hardening Phase roadmap in `CLAUDE.md`).
```

- [ ] **Step 5: Update README's "Locality grouping is self-reported and unverified" paragraph**

Find this text in `README.md` (immediately after the paragraph replaced in
Step 4):

```markdown
**Locality grouping is self-reported and unverified:** `localityGroup` is an
arbitrary string a node supplies at registration time — the coordinator
performs no check that it reflects real physical or network proximity. A
node can claim membership in any group, including one it has no actual
adjacency to, with no cost or detection beyond holding the shared
`SWARM_AUTH_TOKEN` (the same shared-token caveat above applies here too —
registration now requires the token, but any token-holder can still claim
any group for free). This is worse than a single false claim: because
`NodeRegistry.register()` mints a fresh `randomUUID()` on every call with no
endpoint dedupe (the same gap noted in the reputation gaming-vectors above),
one physical device can register itself repeatedly under different
`localityGroup` values and appear in multiple groups simultaneously —
inflating any group's apparent size for free, or flooding every group at
once. Verified live: the same endpoint registered under `"kitchen-mesh"`,
`"office-mesh"`, and `"garage-mesh"` produced 3 distinct nodeIds, all live
simultaneously in `GET /nodes/locality`, all backed by the same physical
endpoint; re-registering under a new group does not remove the old
registration either, so the stale entry persists in its original group
until its normal liveness/heartbeat timeout (currently 30s) expires. This
matters beyond the general shared-token caveat because `GET /nodes/locality`
exists as groundwork for a future pipeline assembler that will likely
prefer larger or majority locality clusters when selecting nodes — making
this a vector against the exact consumer this endpoint is groundwork for.
The root cause is the same missing stable-node-identity fix already named
as a prerequisite in the reputation gaming-vectors note above; see that
paragraph rather than repeating it here. Separately, a node can also
register with `localityGroup: "ungrouped"` verbatim, which is
indistinguishable from a node that never set the field at all. `GET
/nodes/locality` exists purely as a stable, queryable interface for
grouping; no pipeline-assembly or locality-aware request-routing system in
this repo yet consumes it — `POST /generate` (Phase A, see below) is a
simple first-match scan over active nodes with no locality-awareness at
all, and this repo still has no cross-instance (federated) or multi-node
pipeline-aware request routing of any kind. No client-side mesh-discovery
mechanism (WiFi Direct, Multipeer Connectivity, LAN broadcast) yet exists
to produce real, verifiable locality identifiers, either.
```

Replace it with:

```markdown
**Locality grouping is self-reported and unverified:** `localityGroup` is an
arbitrary string a node supplies at registration time — the coordinator
performs no check that it reflects real physical or network proximity. A
node can claim membership in any group, including one it has no actual
adjacency to, with no cost or detection beyond holding the shared
`SWARM_AUTH_TOKEN` (the same shared-token caveat above applies here too —
registration now requires the token, but any token-holder can still claim
any group for free). **Security Hardening Phase 3 fixed the amplified
version of this:** before that phase, `NodeRegistry.register()` minted a
fresh `randomUUID()` on every call with no endpoint dedupe, so one physical
device could register itself repeatedly under different `localityGroup`
values and appear in multiple groups simultaneously — verified live at the
time: the same endpoint registered under `"kitchen-mesh"`, `"office-mesh"`,
and `"garage-mesh"` produced 3 distinct nodeIds, all live simultaneously in
`GET /nodes/locality`. `nodeId` is now a deterministic hash of the endpoint
(see the reputation gaming-vectors note above), so re-registering the same
endpoint under a new group now overwrites the previous registration instead
of adding to it — a node can still claim any single group it likes, but can
no longer occupy several at once. This matters because `GET
/nodes/locality` exists as groundwork for a future pipeline assembler that
will likely prefer larger or majority locality clusters when selecting
nodes; the fix removes the cheapest way to inflate a group's apparent size
for free. The base truthfulness gap remains open: a single false claim
about which one group a node belongs to is still free and undetected.
Separately, a node can also register with `localityGroup: "ungrouped"`
verbatim, which is indistinguishable from a node that never set the field
at all. `GET /nodes/locality` exists purely as a stable, queryable
interface for grouping; no pipeline-assembly or locality-aware
request-routing system in this repo yet consumes it — `POST /generate`
(Phase A, see below) is a simple first-match scan over active nodes with no
locality-awareness at all, and this repo still has no cross-instance
(federated) or multi-node pipeline-aware request routing of any kind. No
client-side mesh-discovery mechanism (WiFi Direct, Multipeer Connectivity,
LAN broadcast) yet exists to produce real, verifiable locality identifiers,
either.
```

- [ ] **Step 6: Full verification**

Run: `cd coordinator && npm test`
Expected: PASS, all tests (pre-existing plus every test added in Tasks 1-2).

Then a live check — start the real coordinator and reproduce the exact
scenario the old README described as "verified live", confirming it no
longer works, from the command line:

```bash
cd coordinator
SWARM_AUTH_TOKEN=verify-token PORT=18299 node src/main.ts &
sleep 1
NODE_ID=$(curl -s -X POST http://127.0.0.1:18299/nodes/register \
  -H "authorization: Bearer verify-token" -H "content-type: application/json" \
  -d '{"endpoint":"http://127.0.0.1:1","deviceTier":"desktop"}' | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf-8')).nodeId)")
echo "nodeId: $NODE_ID"
for i in 1 2 3 4 5; do
  curl -s -X POST "http://127.0.0.1:18299/nodes/$NODE_ID/reputation/disagree" -H "authorization: Bearer verify-token" > /dev/null
done
echo "after 5 disagreements, GET /nodes:"
curl -s http://127.0.0.1:18299/nodes -H "authorization: Bearer verify-token"
echo
echo "re-registering the same endpoint:"
NODE_ID_2=$(curl -s -X POST http://127.0.0.1:18299/nodes/register \
  -H "authorization: Bearer verify-token" -H "content-type: application/json" \
  -d '{"endpoint":"http://127.0.0.1:1","deviceTier":"desktop"}' | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf-8')).nodeId)")
echo "nodeId: $NODE_ID_2 (expect identical to $NODE_ID)"
echo "GET /nodes after re-registering (expect still empty -- not revived):"
curl -s http://127.0.0.1:18299/nodes -H "authorization: Bearer verify-token"
echo
kill %1
```

Expected: `NODE_ID_2` is byte-identical to `NODE_ID`, and both `GET /nodes`
calls return `[]` — the node stays ejected after re-registration, unlike
`master`'s current behavior where the second `GET /nodes` call would show
the node reappeared with a clean slate. Confirm no orphaned `node.exe`
process remains afterward (`tasklist //FI "IMAGENAME eq node.exe"` on
Windows should show nothing from this check once the `kill` above has
taken effect).

- [ ] **Step 7: Commit**

```bash
git add coordinator/tests/server.test.ts README.md
git commit -m "Add HTTP-level regression coverage and document the sybil-resistance fix"
```

---

## What this plan does not do

- **Decay/windowing of the disagreement ratio.** An established node with
  a long good history still needs an implausible run of consecutive
  disagreements to be ejected. This is a scoring-algorithm change to
  `ReputationTracker`, not an identity fix, and is unscoped and undesigned
  as of this plan.
- **Defense against an attacker minting many distinct fake identities.**
  This plan makes a *given endpoint string's* identity stable and
  non-resettable, not a given physical node's — `stableNodeId()` only
  lowercases the endpoint, it does not canonicalize it, so one listening
  socket answers to unlimited alias strings (`127.0.0.1` vs `localhost` vs
  `[::1]` vs a trailing-dot FQDN vs any other DNS name pointed at it) for
  free, with no new port or infrastructure required — each alias gets a
  fresh, clean identity. This is a materially bigger gap than "register
  several ports on one machine"; whole-branch review caught and verified
  it live (see README's "Known gaming vectors"), and it should be named
  accurately anywhere this plan's residual scope is summarized.
- **`localityGroup` truthfulness.** A node can still falsely claim
  membership in any single locality group with no verification. This plan
  only removes the ability to claim several groups simultaneously *under
  the same endpoint string* — the same aliasing gap above means a single
  physical device can still occupy several groups at once, one per alias.
- **Node-supplied public-key identity.** Considered in the design doc and
  rejected for this phase as a materially bigger scope (key generation,
  registration flow, rotation/loss story) — endpoint-derived identity is
  weaker (spoofable by controlling the claimed endpoint) but proportionate
  to what this phase needs to fix.
- **Federation-level (cross-coordinator) sybil-resistance.** The master
  spec (`docs/superpowers/specs/2026-08-14-distributed-llm-inference-design.md`)
  separately names a need for sybil-resistance at the federation/instance
  level — preventing one operator from fabricating many "partner"
  coordinator identities to manipulate routing or reputation across
  instances. This plan is entirely about `NodeRegistry` (nodes registering
  with *one* coordinator); it does not touch `PeerRegistry` or any
  cross-coordinator trust mechanism.
- **Reputation persistence across a coordinator restart.** Every piece of
  state in this service remains in-memory only, by disclosed design. A
  restarted coordinator still forgets all reputation history for every
  node — identity is stable only within a single running process's
  lifetime.
- **Reputation-ranked node selection.** That's Security Hardening Phase 4,
  a separate, not-yet-designed plan.
