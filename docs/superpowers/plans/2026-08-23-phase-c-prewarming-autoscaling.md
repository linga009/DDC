# Phase C: Pre-Warming & Autoscaling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Phase B's synchronous, single-pipeline-per-model assembly with a background reconciliation loop that proactively assembles and scales a pool of warm pipelines per model based on recent demand, while never preempting an already-live pipeline to give its launcher to a busier model.

**Architecture:** `PipelineTracker` becomes a real pool (`Map<modelId, PooledPipeline[]>`, up to a new `maxPipelines` catalog cap) instead of a single-slot tracker. A new `DemandTracker` records a sliding 60-second request-count window per model. A new `PipelinePoolManager` runs a periodic loop that health-checks existing pool entries, scales down idle ones (via a new `DELETE /pipeline` launcher endpoint this plan adds), computes each model's desired pipeline count from a deliberately naive demand-to-count function, and allocates genuinely idle launchers to under-provisioned models in demand-sorted order. `POST /generate` tries the model's pool first (round-robin), falling back to today's existing synchronous `ensurePipelineReady()` assembly path only when the pool is empty.

**Tech Stack:** C++17 (`core/`, CMake+Ninja, GoogleTest via ctest) + Node.js 22.6+ native TypeScript (`coordinator/`, zero dependencies, `node:test`).

## Global Constraints

- **Never add a `Co-Authored-By: Claude` trailer to any commit.** State this in every dispatch — it does not carry over automatically.
- C++: build via `cmake -G Ninja -S . -B build && cmake --build build`. Run tests via `cd build && ctest`. Environment prelude for every C++ build/test command: `export PATH="/c/msys64/ucrt64/bin:$PATH"; export CCACHE_DIR=/c/Users/User/.ccache`.
- Coordinator: zero npm dependencies. Only `node:http`, `node:test`, `node:assert/strict`, `node:crypto`, native `fetch`, `AbortSignal.timeout`.
- **A launcher already hosting a live pipeline is never killed to free it for a different, busier model.** It only becomes reallocatable once its own model's scale-down/grace-period/reassembly-on-ejection logic frees it. This is a resolved, user-approved design decision — do not add preemption.
- **`PipelineTracker`'s old single-slot API (`get`/`markWarm`/`markFailed`) is removed entirely, not kept alongside the new pool-shaped one.** Every caller (in `server.ts`, in tests) is migrated in the same task that changes the data structure — this plan does not tolerate a transitional period with both APIs coexisting.
- Every existing behavior this plan touches must remain byte-for-byte unchanged for a `requiredNodeCount === 1` model. Every existing test in `core/tests/` and `coordinator/tests/` must keep passing (with the specific, enumerated exception of the tests this plan's own tasks explicitly update to the new `PipelineTracker` API — see Task 4).
- Design doc: [`docs/superpowers/specs/2026-08-23-phase-c-prewarming-autoscaling-implementation-design.md`](docs/superpowers/specs/2026-08-23-phase-c-prewarming-autoscaling-implementation-design.md) — read this for the full reasoning behind every decision below; this plan implements it, not re-derives it.

---

### Task 1: `catalog.ts` gains `maxPipelines`

**Files:**
- Modify: `coordinator/src/catalog.ts`
- Test: `coordinator/tests/catalog.test.ts`

**Interfaces:**
- Produces: `CatalogEntry.maxPipelines?: number` (default `1` when absent). `ModelCatalog` gains `maxPipelines(modelId: string): number`, returning `1` for an unknown model id (never throws). Task 6 depends on this exact method name and default-`1` behavior.

- [ ] **Step 1: Write the failing tests**

Read `coordinator/tests/catalog.test.ts` in full first to match its exact style (it already tests `requiredNodeCount` the same way this task tests `maxPipelines`).

Add these tests:

```typescript
test("maxPipelines defaults to 1 for a catalog entry that doesn't specify it", () => {
  const catalog = new ModelCatalog([{ id: "small", displayName: "Small", minActiveNodes: 0 }]);
  assert.equal(catalog.maxPipelines("small"), 1);
});

test("maxPipelines returns the entry's own value when specified", () => {
  const catalog = new ModelCatalog([{ id: "big", displayName: "Big", minActiveNodes: 5, maxPipelines: 4 }]);
  assert.equal(catalog.maxPipelines("big"), 4);
});

test("maxPipelines returns 1 for an unknown model id", () => {
  const catalog = new ModelCatalog([{ id: "small", displayName: "Small", minActiveNodes: 0 }]);
  assert.equal(catalog.maxPipelines("nonexistent-model"), 1);
});
```

- [ ] **Step 2: Confirm the tests fail**

Run: `cd coordinator && npm test -- --test-name-pattern="maxPipelines"`
Expected: FAIL — `catalog.maxPipelines is not a function`.

- [ ] **Step 3: Update `catalog.ts`**

Find:

```typescript
export interface CatalogEntry {
  id: string;
  displayName: string;
  minActiveNodes: number;
  // Total pipeline size (driver plus compute contributors together, not
  // contributors alone) this model needs to run at all -- absent or 1
  // means today's existing single-node path, untouched by Phase B. Only
  // >1 models ever engage pipeline_selector.ts/PipelineTracker/the
  // launcher.
  requiredNodeCount?: number;
}
```

Replace with:

```typescript
export interface CatalogEntry {
  id: string;
  displayName: string;
  minActiveNodes: number;
  // Total pipeline size (driver plus compute contributors together, not
  // contributors alone) this model needs to run at all -- absent or 1
  // means today's existing single-node path, untouched by Phase B. Only
  // >1 models ever engage pipeline_selector.ts/PipelineTracker/the
  // launcher.
  requiredNodeCount?: number;
  // Ceiling on how many CONCURRENT pipelines (each requiredNodeCount
  // nodes large) Phase C's pool manager will keep warm for this model at
  // once -- absent or 1 keeps today's Phase B behavior (at most one
  // pipeline, assembled on demand). Only meaningful alongside
  // requiredNodeCount > 1; a model that doesn't need a multi-node
  // pipeline at all has nothing for this to scale.
  maxPipelines?: number;
}
```

Find:

```typescript
  requiredNodeCount(id: string): number {
    return this.entries.find(entry => entry.id === id)?.requiredNodeCount ?? 1;
  }
```

Replace with:

```typescript
  requiredNodeCount(id: string): number {
    return this.entries.find(entry => entry.id === id)?.requiredNodeCount ?? 1;
  }

  maxPipelines(id: string): number {
    return this.entries.find(entry => entry.id === id)?.maxPipelines ?? 1;
  }
```

- [ ] **Step 4: Run the tests**

Run: `cd coordinator && npm test -- --test-name-pattern="maxPipelines"`
Expected: PASS (all 3 new tests green).

- [ ] **Step 5: Run the full coordinator suite (regression check)**

Run: `cd coordinator && npm test`
Expected: PASS, all tests. Baseline is 286 (per Phase B's final merged state); expect 289.

- [ ] **Step 6: Commit**

```bash
git add coordinator/src/catalog.ts coordinator/tests/catalog.test.ts
git commit -m "ModelCatalog gains maxPipelines, defaulting to 1 for every existing entry"
```

---

### Task 2: `swarm-launcher` gains `DELETE /pipeline`

**Files:**
- Modify: `core/src/launcher_main.cpp`
- Test: `core/tests/launcher_test.cpp`

**Interfaces:**
- Produces: `DELETE /pipeline` on the launcher — no request body. Kills the currently-spawned agent if one exists; is a no-op (still success) if none does. Returns `204` with an empty body, always. Task 6 depends on this exact method/path/status/idempotency.

- [ ] **Step 1: Write the failing test**

Read `core/tests/launcher_test.cpp` in full first (its `LauncherFixture` class, `sendRawRequest`/`waitForLauncherUp`/`killAnyRunningLauncher` helpers, and existing tests' style) to match it exactly — this project's established convention is grounding against current file state, not memory.

Add this test, in the same `LauncherFixture` test class the file's other tests already use:

```cpp
TEST_F(LauncherFixture, DeletePipelineKillsARunningAgentAndReturns204) {
    std::string body = R"({"model":"tinyllama-1.1b-chat-v1.0.Q4_K_M","remoteEndpoints":"","layerPlacements":""})";
    std::string spawnRequest = "POST /pipeline HTTP/1.1\r\nContent-Length: " + std::to_string(body.size()) +
                                "\r\nContent-Type: application/json\r\n\r\n" + body;
    std::string spawnResponse = sendRawRequest(kLauncherPort, spawnRequest);
    ASSERT_NE(spawnResponse.find("HTTP/1.1 200"), std::string::npos);

    // Confirm the agent is genuinely up before deleting it.
    std::string healthBefore = sendRawRequest(
        kAgentPort,
        "GET /health HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + std::string(kTestAuthToken) + "\r\n\r\n");
    ASSERT_NE(healthBefore.find("HTTP/1.1 200"), std::string::npos);

    std::string deleteRequest = "DELETE /pipeline HTTP/1.1\r\nContent-Length: 0\r\n\r\n";
    std::string deleteResponse = sendRawRequest(kLauncherPort, deleteRequest);
    EXPECT_NE(deleteResponse.find("HTTP/1.1 204"), std::string::npos);

    // Real, live proof the agent process is actually gone -- not just that
    // the launcher claimed success. A fresh connection attempt to its port
    // must fail once it's genuinely dead; give the OS a moment to finish
    // tearing the process down.
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    bool agentStillReachable = false;
    try {
        sendRawRequest(kAgentPort, "GET /health HTTP/1.1\r\nHost: x\r\n\r\n");
        agentStillReachable = true;
    } catch (const std::exception&) {
        agentStillReachable = false;
    }
    EXPECT_FALSE(agentStillReachable);
}

TEST_F(LauncherFixture, DeletePipelineWithNoAgentRunningIsANoOpThatStillReturns204) {
    std::string deleteRequest = "DELETE /pipeline HTTP/1.1\r\nContent-Length: 0\r\n\r\n";
    std::string deleteResponse = sendRawRequest(kLauncherPort, deleteRequest);
    EXPECT_NE(deleteResponse.find("HTTP/1.1 204"), std::string::npos);

    // Calling it again immediately must still succeed (idempotent).
    std::string secondDeleteResponse = sendRawRequest(kLauncherPort, deleteRequest);
    EXPECT_NE(secondDeleteResponse.find("HTTP/1.1 204"), std::string::npos);
}
```

If `sendRawRequest` throwing on a failed connect isn't already this file's established pattern (check the actual current helper's behavior — it may return an empty string on failure instead of throwing), adapt the first test's `agentStillReachable` check to match whatever failure signal the real helper actually gives, rather than assuming it throws.

- [ ] **Step 2: Confirm the tests fail**

```
export PATH="/c/msys64/ucrt64/bin:$PATH"; export CCACHE_DIR=/c/Users/User/.ccache
cmake --build build --target inference_engine_test
cd build && ctest -R "LauncherFixture.DeletePipeline" --output-on-failure
```
Expected: FAIL — the launcher has no route for `DELETE /pipeline`, so `HttpServer` falls through to its default 404, and the response won't contain `HTTP/1.1 204`.

- [ ] **Step 3: Add the route to `core/src/launcher_main.cpp`**

Find (the end of the existing `POST /pipeline` route, immediately followed by `server.run()`):

```cpp
        currentAgent = std::move(spawned);
        return swarm::HttpResponse{200, R"({"status":"ready"})"};
    });

    server.run();  // blocks forever
```

Replace with:

```cpp
        currentAgent = std::move(spawned);
        return swarm::HttpResponse{200, R"({"status":"ready"})"};
    });

    // Scale-down primitive for Phase C's pool manager: stop whatever this
    // launcher is currently running, with no replacement. Idempotent --
    // calling this with nothing running is a successful no-op, matching
    // this project's established convention for tear-down-style endpoints
    // (POST /peers/:peerId/heartbeat's sibling DELETE /peers/:peerId
    // returns 404 for "already gone," but that's a coordinator-side
    // registry lookup; here there is nothing to look up -- "no agent
    // running" and "agent successfully stopped" are the same outcome from
    // a caller's point of view, so both return 204). No request body.
    server.route("DELETE", "/pipeline", [&](const swarm::HttpRequest&) -> swarm::HttpResponse {
        currentAgent.reset();
        return swarm::HttpResponse{204, ""};
    });

    server.run();  // blocks forever
```

- [ ] **Step 4: Run the new tests**

```
export PATH="/c/msys64/ucrt64/bin:$PATH"; export CCACHE_DIR=/c/Users/User/.ccache
cmake --build build
cd build && ctest -R "LauncherFixture.DeletePipeline" --output-on-failure
```
Expected: 100% pass, both new tests green.

- [ ] **Step 5: Run the full suite (regression check)**

```
cd build && ctest --output-on-failure
```
Expected: 100% pass. Baseline (per Phase B's final merged state) is 113; expect 115.

- [ ] **Step 6: Commit**

```bash
git add core/src/launcher_main.cpp core/tests/launcher_test.cpp
git commit -m "Add DELETE /pipeline to swarm-launcher: stop the current agent, no replacement"
```

---

### Task 3: `demand_tracker.ts` — sliding-window request counter

**Files:**
- Create: `coordinator/src/demand_tracker.ts`
- Test: `coordinator/tests/demand_tracker.test.ts` (new file)

**Interfaces:**
- Produces: `DemandTracker` class with `recordRequest(modelId: string): void` and `recentDemand(modelId: string): number` (count of `recordRequest` calls for that model in the trailing 60-second window, as of the injectable clock's current time). Task 6 and Task 7 depend on these exact method names.

- [ ] **Step 1: Write the failing tests**

Create `coordinator/tests/demand_tracker.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { DemandTracker } from "../src/demand_tracker.ts";

test("recentDemand is 0 for a model with no recorded requests", () => {
  const tracker = new DemandTracker();
  assert.equal(tracker.recentDemand("some-model"), 0);
});

test("recentDemand counts requests recorded within the window", () => {
  const clock = { now: 1000 };
  const tracker = new DemandTracker(() => clock.now);
  tracker.recordRequest("model-a");
  tracker.recordRequest("model-a");
  tracker.recordRequest("model-a");
  assert.equal(tracker.recentDemand("model-a"), 3);
});

test("recentDemand excludes requests older than the 60-second window", () => {
  const clock = { now: 1000 };
  const tracker = new DemandTracker(() => clock.now);
  tracker.recordRequest("model-a");
  clock.now += 30000;
  tracker.recordRequest("model-a");
  clock.now += 30001; // now 60001ms after the FIRST request -- it should have aged out
  assert.equal(tracker.recentDemand("model-a"), 1);
});

test("recentDemand is tracked independently per model", () => {
  const tracker = new DemandTracker();
  tracker.recordRequest("model-a");
  tracker.recordRequest("model-a");
  tracker.recordRequest("model-b");
  assert.equal(tracker.recentDemand("model-a"), 2);
  assert.equal(tracker.recentDemand("model-b"), 1);
});

test("recentDemand for a model whose requests all aged out returns 0, not stale data", () => {
  const clock = { now: 1000 };
  const tracker = new DemandTracker(() => clock.now);
  tracker.recordRequest("model-a");
  clock.now += 60001;
  assert.equal(tracker.recentDemand("model-a"), 0);
});
```

- [ ] **Step 2: Confirm the tests fail**

Run: `cd coordinator && npm test -- --test-name-pattern="recentDemand"`
Expected: FAIL — `Cannot find module '../src/demand_tracker.ts'`.

- [ ] **Step 3: Create `coordinator/src/demand_tracker.ts`**

```typescript
const WINDOW_MS = 60000;

// In-memory only, same as every other piece of coordinator state
// (NodeRegistry, PeerRegistry, ReputationTracker, PipelineTracker) -- a
// deliberate, disclosed limitation, not a gap. A coordinator restart loses
// demand history and the window starts fresh.
export class DemandTracker {
  private readonly clock: () => number;
  private readonly timestamps = new Map<string, number[]>();

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  recordRequest(modelId: string): void {
    const list = this.timestamps.get(modelId);
    if (list) {
      list.push(this.clock());
    } else {
      this.timestamps.set(modelId, [this.clock()]);
    }
  }

  recentDemand(modelId: string): number {
    const list = this.timestamps.get(modelId);
    if (!list) {
      return 0;
    }
    const cutoff = this.clock() - WINDOW_MS;
    // Prune in place (lazy, on read) -- same style as NodeRegistry's own
    // prune-on-iterate pattern -- so a model with no recent traffic
    // doesn't accumulate an unbounded timestamp list forever.
    let firstLiveIndex = 0;
    while (firstLiveIndex < list.length && list[firstLiveIndex] <= cutoff) {
      firstLiveIndex++;
    }
    if (firstLiveIndex > 0) {
      list.splice(0, firstLiveIndex);
    }
    return list.length;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd coordinator && npm test -- --test-name-pattern="recentDemand"`
Expected: PASS (all 5 new tests green).

- [ ] **Step 5: Run the full coordinator suite (regression check)**

Run: `cd coordinator && npm test`
Expected: PASS, all tests. Baseline after Task 1 is 289; expect 294.

- [ ] **Step 6: Commit**

```bash
git add coordinator/src/demand_tracker.ts coordinator/tests/demand_tracker.test.ts
git commit -m "Add DemandTracker: sliding 60s request-count window per model"
```

---

### Task 4: `pipeline_tracker.ts` rewrite (pool-shaped) + `server.ts` adaptation

**Files:**
- Modify: `coordinator/src/pipeline_tracker.ts` (full rewrite)
- Modify: `coordinator/src/server.ts` (`ensurePipelineReady`, `markDriverFailedIfTracked`)
- Test: `coordinator/tests/pipeline_tracker.test.ts` (full rewrite)
- Test: `coordinator/tests/server.test.ts` (update 5 existing call sites)

**Interfaces:**
- Produces: `PooledPipeline { pipelineId: string; driverNodeId: string; computeNodeIds: string[]; launcherId: string; state: "warm" | "assembling" | "failed"; lastUsedAt: number }`. `PipelineTracker` gains `getPool(modelId): PooledPipeline[]` (never `undefined`, empty array for no entries), `addEntry(modelId, entry: PooledPipeline): void`, `removeEntry(modelId, pipelineId): void`, `markEntryFailed(modelId, pipelineId): void`. The old `get`/`markWarm`/`markFailed` methods are deleted. Task 6 and Task 7 depend on this exact interface.
- Consumes: nothing new — this task's job is purely the data-structure change and keeping every existing caller compiling and behaving identically for the single-pipeline case Phase B already exercises.

**This task makes NO user-visible behavior change.** `ensurePipelineReady()` still assembles at most one pipeline per model, synchronously, on demand, exactly as it does on `master` today — it's just backed by a `PooledPipeline[]` of length 0 or 1 instead of a single `TrackedPipeline | undefined`. Task 6 and Task 7 are what add genuinely new pooling/round-robin behavior on top of this same data structure.

- [ ] **Step 1: Write the failing `pipeline_tracker.test.ts` tests**

Replace the entire contents of `coordinator/tests/pipeline_tracker.test.ts` with:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { PipelineTracker, type PooledPipeline } from "../src/pipeline_tracker.ts";

function entry(overrides: Partial<PooledPipeline> = {}): PooledPipeline {
  return {
    pipelineId: "pipeline-1",
    driverNodeId: "driver-1",
    computeNodeIds: [],
    launcherId: "launcher-1",
    state: "warm",
    lastUsedAt: 1000,
    ...overrides,
  };
}

test("getPool returns an empty array for a model with no entries", () => {
  const tracker = new PipelineTracker();
  assert.deepEqual(tracker.getPool("mixtral-8x7b"), []);
});

test("addEntry then getPool reports the added entry", () => {
  const tracker = new PipelineTracker();
  tracker.addEntry("mixtral-8x7b", entry());
  assert.deepEqual(tracker.getPool("mixtral-8x7b"), [entry()]);
});

test("addEntry accumulates multiple entries for the same model", () => {
  const tracker = new PipelineTracker();
  tracker.addEntry("mixtral-8x7b", entry({ pipelineId: "p1", driverNodeId: "d1", launcherId: "l1" }));
  tracker.addEntry("mixtral-8x7b", entry({ pipelineId: "p2", driverNodeId: "d2", launcherId: "l2" }));
  assert.equal(tracker.getPool("mixtral-8x7b").length, 2);
});

test("removeEntry removes exactly the named entry, leaving others", () => {
  const tracker = new PipelineTracker();
  tracker.addEntry("mixtral-8x7b", entry({ pipelineId: "p1" }));
  tracker.addEntry("mixtral-8x7b", entry({ pipelineId: "p2" }));
  tracker.removeEntry("mixtral-8x7b", "p1");
  const pool = tracker.getPool("mixtral-8x7b");
  assert.equal(pool.length, 1);
  assert.equal(pool[0].pipelineId, "p2");
});

test("removeEntry for an unknown pipelineId is a harmless no-op", () => {
  const tracker = new PipelineTracker();
  tracker.addEntry("mixtral-8x7b", entry({ pipelineId: "p1" }));
  tracker.removeEntry("mixtral-8x7b", "nonexistent");
  assert.equal(tracker.getPool("mixtral-8x7b").length, 1);
});

test("removeEntry for a model with no pool at all is a harmless no-op", () => {
  const tracker = new PipelineTracker();
  tracker.removeEntry("nonexistent-model", "p1");
  assert.deepEqual(tracker.getPool("nonexistent-model"), []);
});

test("markEntryFailed sets that entry's state to failed without removing it", () => {
  const tracker = new PipelineTracker();
  tracker.addEntry("mixtral-8x7b", entry({ pipelineId: "p1", state: "warm" }));
  tracker.markEntryFailed("mixtral-8x7b", "p1");
  const pool = tracker.getPool("mixtral-8x7b");
  assert.equal(pool.length, 1);
  assert.equal(pool[0].state, "failed");
});

test("markEntryFailed for an unknown pipelineId is a harmless no-op", () => {
  const tracker = new PipelineTracker();
  tracker.addEntry("mixtral-8x7b", entry({ pipelineId: "p1", state: "warm" }));
  tracker.markEntryFailed("mixtral-8x7b", "nonexistent");
  assert.equal(tracker.getPool("mixtral-8x7b")[0].state, "warm");
});

test("tracking is independent per model id", () => {
  const tracker = new PipelineTracker();
  tracker.addEntry("mixtral-8x7b", entry({ pipelineId: "p1" }));
  tracker.addEntry("mixtral-8x22b", entry({ pipelineId: "p2" }));
  assert.equal(tracker.getPool("mixtral-8x7b").length, 1);
  assert.equal(tracker.getPool("mixtral-8x22b").length, 1);
  assert.equal(tracker.getPool("mixtral-8x7b")[0].pipelineId, "p1");
});
```

- [ ] **Step 2: Confirm it fails**

Run: `cd coordinator && npm test -- --test-name-pattern="getPool|addEntry|removeEntry|markEntryFailed"`
Expected: FAIL — the current `PipelineTracker` has none of these methods.

- [ ] **Step 3: Rewrite `coordinator/src/pipeline_tracker.ts`**

Replace the entire file with:

```typescript
export type PooledPipelineState = "warm" | "assembling" | "failed";

export interface PooledPipeline {
  pipelineId: string;
  driverNodeId: string;
  computeNodeIds: string[];
  launcherId: string;
  state: PooledPipelineState;
  lastUsedAt: number;
}

// In-memory only, same as every other piece of coordinator state
// (NodeRegistry, PeerRegistry, ReputationTracker, DemandTracker) -- a
// deliberate, disclosed limitation, not a gap. Multiple pool entries per
// model id are now supported (Phase C) -- Phase B's own single-slot
// version is gone, not kept alongside this one; every caller uses this
// pool-shaped API.
export class PipelineTracker {
  private readonly pools = new Map<string, PooledPipeline[]>();

  getPool(modelId: string): PooledPipeline[] {
    return this.pools.get(modelId) ?? [];
  }

  addEntry(modelId: string, entry: PooledPipeline): void {
    const pool = this.pools.get(modelId);
    if (pool) {
      pool.push(entry);
    } else {
      this.pools.set(modelId, [entry]);
    }
  }

  removeEntry(modelId: string, pipelineId: string): void {
    const pool = this.pools.get(modelId);
    if (!pool) {
      return;
    }
    const index = pool.findIndex(entry => entry.pipelineId === pipelineId);
    if (index !== -1) {
      pool.splice(index, 1);
    }
  }

  markEntryFailed(modelId: string, pipelineId: string): void {
    const pool = this.pools.get(modelId);
    const entry = pool?.find(e => e.pipelineId === pipelineId);
    if (entry) {
      entry.state = "failed";
    }
  }
}
```

- [ ] **Step 4: Run the `pipeline_tracker.ts` tests**

Run: `cd coordinator && npm test -- --test-name-pattern="getPool|addEntry|removeEntry|markEntryFailed"`
Expected: PASS (all 9 new tests green).

- [ ] **Step 5: Adapt `ensurePipelineReady()` in `coordinator/src/server.ts`**

Read the current file to find `ensurePipelineReady`'s exact current body (it calls `pipelineTracker.get`, `.markWarm`, `.markFailed` — all three now compile-broken after Step 3). Find:

```typescript
  const tracked = pipelineTracker.get(modelId);
  if (tracked?.state === "warm" && tracked.driverNodeId) {
    const driverStillActive = registry.listActive(reputation).some(n => n.nodeId === tracked.driverNodeId);
    if (driverStillActive) {
```

Replace with:

```typescript
  // At most one entry can exist here -- this synchronous, cold-start-only
  // path never adds a second one (Task 6's pool manager is what grows a
  // pool past size 1). Reading index 0 rather than introducing a new
  // "single tracked entry" concept keeps this function's own state
  // entirely inside PipelineTracker's one pool-shaped API, with nothing
  // parallel to keep in sync.
  const pool = pipelineTracker.getPool(modelId);
  const tracked = pool[0];
  if (tracked?.state === "warm") {
    const driverStillActive = registry.listActive(reputation).some(n => n.nodeId === tracked.driverNodeId);
    if (driverStillActive) {
```

Find (the same function, a little further down — the successful-assembly path):

```typescript
    const launcherUrl = new URL(launcher.endpoint);
    const driverEndpoint = `${launcherUrl.protocol}//${launcherUrl.hostname}:${launcher.agentPort}`;
    const driverNodeId = registry.register(driverEndpoint, "desktop", undefined, modelId);
    pipelineTracker.markWarm(modelId, driverNodeId, selection.computeContributors.map(n => n.nodeId));
  } catch (err) {
    console.warn(`failed to assemble pipeline for model ${modelId} via launcher ${launcher.endpoint}:`, err);
    pipelineTracker.markFailed(modelId);
  }
}
```

Replace with:

```typescript
    const launcherUrl = new URL(launcher.endpoint);
    const driverEndpoint = `${launcherUrl.protocol}//${launcherUrl.hostname}:${launcher.agentPort}`;
    const driverNodeId = registry.register(driverEndpoint, "desktop", undefined, modelId);
    // Replace whatever was tracked before (if anything -- there is at
    // most one entry on this cold-start path) with the freshly-assembled
    // pipeline, rather than appending a second entry alongside a stale
    // one.
    if (tracked) {
      pipelineTracker.removeEntry(modelId, tracked.pipelineId);
    }
    pipelineTracker.addEntry(modelId, {
      pipelineId: randomUUID(),
      driverNodeId,
      computeNodeIds: selection.computeContributors.map(n => n.nodeId),
      launcherId: launcher.launcherId,
      state: "warm",
      lastUsedAt: Date.now(),
    });
  } catch (err) {
    console.warn(`failed to assemble pipeline for model ${modelId} via launcher ${launcher.endpoint}:`, err);
    if (tracked) {
      pipelineTracker.markEntryFailed(modelId, tracked.pipelineId);
    }
  }
}
```

`randomUUID` is already imported at the top of `server.ts` (`import { timingSafeEqual, randomUUID } from "node:crypto";`) — no new import needed.

- [ ] **Step 6: Adapt `markDriverFailedIfTracked` in `coordinator/src/server.ts`**

Find:

```typescript
        const markDriverFailedIfTracked = () => {
          if (pipelineTracker.get(candidate.modelId)?.driverNodeId === node.nodeId) {
            pipelineTracker.markFailed(candidate.modelId);
          }
        };
```

Replace with:

```typescript
        const markDriverFailedIfTracked = () => {
          const entry = pipelineTracker.getPool(candidate.modelId).find(e => e.driverNodeId === node.nodeId);
          if (entry) {
            pipelineTracker.markEntryFailed(candidate.modelId, entry.pipelineId);
          }
        };
```

(This now searches the whole pool for a matching driver rather than checking a single tracked entry — a no-op change in today's cold-start-only-populated-pool world, since the pool never holds more than one entry until Task 6 lands, but it means this same code needs no further change once Task 6 and Task 7 make pools grow past size 1: whichever pool entry actually failed gets marked, regardless of how it was selected.)

- [ ] **Step 7: Update the 5 existing `server.test.ts` call sites using the old API**

Read the current file to find each of these 5 call sites (searching for `pipelineTracker.markWarm(` will find all of them) and confirm the exact surrounding test code before editing — this project's established convention.

Each occurrence of a pattern like:

```typescript
    const driverNodeId = registry.register(stub.endpoint, "desktop", undefined, "big-model");
    pipelineTracker.markWarm("big-model", driverNodeId, []);
```

Becomes:

```typescript
    const driverNodeId = registry.register(stub.endpoint, "desktop", undefined, "big-model");
    pipelineTracker.addEntry("big-model", {
      pipelineId: "test-pipeline-1",
      driverNodeId,
      computeNodeIds: [],
      launcherId: "test-launcher-1",
      state: "warm",
      lastUsedAt: Date.now(),
    });
```

And each occurrence of the "stale" pattern:

```typescript
    pipelineTracker.markWarm("big-model", "some-driver-id-not-in-the-registry", []);
```

Becomes:

```typescript
    pipelineTracker.addEntry("big-model", {
      pipelineId: "test-pipeline-stale",
      driverNodeId: "some-driver-id-not-in-the-registry",
      computeNodeIds: [],
      launcherId: "test-launcher-stale",
      state: "warm",
      lastUsedAt: Date.now(),
    });
```

Apply this to all 5 call sites. `pipelineId`/`launcherId` values just need to be unique-enough placeholders within each individual test — they aren't asserted on by these particular tests, only `driverNodeId`/`state` are.

- [ ] **Step 8: Run the full coordinator suite (regression check)**

Run: `cd coordinator && npm test`
Expected: PASS, all tests, zero failures. Baseline after Task 3 is 294; expect 303 (294 − 0 removed + 9 new `pipeline_tracker.test.ts` tests). Every existing `/generate` test for a `requiredNodeCount>1` model (the 5 sites just updated, plus every other Phase B test exercising warm/stale/fresh-assembly behavior) must pass with **identical** observable behavior to before this task — this task changes internal representation only.

- [ ] **Step 9: Commit**

```bash
git add coordinator/src/pipeline_tracker.ts coordinator/src/server.ts coordinator/tests/pipeline_tracker.test.ts coordinator/tests/server.test.ts
git commit -m "Rewrite PipelineTracker as a pool-shaped structure, adapt ensurePipelineReady to it"
```

---

### Task 5: `launcher_registry.ts` gains `listForModel()`

**Files:**
- Modify: `coordinator/src/launcher_registry.ts`
- Test: `coordinator/tests/launcher_registry.test.ts`

**Interfaces:**
- Produces: `LauncherRegistry.listForModel(modelId: string): LauncherInfo[]` — every active launcher whose `servesModels` includes `modelId`, unfiltered by any notion of "already claimed" (the pool manager, Task 6, does that filtering itself). `findForModel()` (Phase B's existing single-match method) is unchanged, still used by `ensurePipelineReady`'s cold-start path.

- [ ] **Step 1: Write the failing tests**

Read `coordinator/tests/launcher_registry.test.ts` in full first to match its existing style for `findForModel`.

Add these tests:

```typescript
test("listForModel returns every active launcher declaring the model", () => {
  const registry = new LauncherRegistry();
  registry.register("http://127.0.0.1:9000", ["mixtral-8x7b"], 8090);
  registry.register("http://127.0.0.1:9001", ["mixtral-8x7b"], 8091);
  registry.register("http://127.0.0.1:9002", ["mixtral-8x22b"], 8092);
  const found = registry.listForModel("mixtral-8x7b");
  assert.equal(found.length, 2);
  assert.deepEqual(found.map(l => l.endpoint).sort(), ["http://127.0.0.1:9000", "http://127.0.0.1:9001"]);
});

test("listForModel returns an empty array when no active launcher declares the model", () => {
  const registry = new LauncherRegistry();
  registry.register("http://127.0.0.1:9000", ["mixtral-8x7b"], 8090);
  assert.deepEqual(registry.listForModel("mixtral-8x22b"), []);
});

test("listForModel excludes an expired launcher", () => {
  const clock = { now: 1000 };
  const registry = new LauncherRegistry(() => clock.now, 30000);
  registry.register("http://127.0.0.1:9000", ["mixtral-8x7b"], 8090);
  clock.now += 40000;
  assert.deepEqual(registry.listForModel("mixtral-8x7b"), []);
});
```

- [ ] **Step 2: Confirm the tests fail**

Run: `cd coordinator && npm test -- --test-name-pattern="listForModel"`
Expected: FAIL — `registry.listForModel is not a function`.

- [ ] **Step 3: Update `coordinator/src/launcher_registry.ts`**

Find:

```typescript
  findForModel(modelId: string): LauncherInfo | undefined {
    return this.listActive().find(launcher => launcher.servesModels.includes(modelId));
  }
```

Replace with:

```typescript
  findForModel(modelId: string): LauncherInfo | undefined {
    return this.listActive().find(launcher => launcher.servesModels.includes(modelId));
  }

  listForModel(modelId: string): LauncherInfo[] {
    return this.listActive().filter(launcher => launcher.servesModels.includes(modelId));
  }
```

- [ ] **Step 4: Run the tests**

Run: `cd coordinator && npm test -- --test-name-pattern="listForModel"`
Expected: PASS (all 3 new tests green).

- [ ] **Step 5: Run the full coordinator suite (regression check)**

Run: `cd coordinator && npm test`
Expected: PASS, all tests. Baseline after Task 4 is 303; expect 306.

- [ ] **Step 6: Commit**

```bash
git add coordinator/src/launcher_registry.ts coordinator/tests/launcher_registry.test.ts
git commit -m "LauncherRegistry gains listForModel(): every active launcher serving a model, unfiltered by claim state"
```

---

### Task 6: `pipeline_pool_manager.ts` — the reconciliation loop

**Files:**
- Create: `coordinator/src/pipeline_pool_manager.ts`
- Test: `coordinator/tests/pipeline_pool_manager.test.ts` (new file)

**Interfaces:**
- Consumes: Task 1's `catalog.maxPipelines()`/`catalog.requiredNodeCount()`, Task 3's `DemandTracker.recentDemand()`, Task 4's `PipelineTracker` pool API, Task 5's `LauncherRegistry.listForModel()`, the existing `pipeline_selector.ts`'s `selectPipeline()`, `NodeRegistry.listActive()`/`heartbeat()`, `ReputationTracker`.
- Produces: `export class PipelinePoolManager` with a constructor taking every dependency plus an injectable `intervalMs` and `idleGraceMs`, and two public methods: `start(): void` (begins a real `setInterval`-driven loop) and `runOnce(): Promise<void>` (executes exactly one reconciliation pass — this is what Task 6's own tests call directly, so they never need to wait on a real timer; `start()` is a thin wrapper that calls `runOnce()` on the interval). `stop(): void` clears the interval (needed for tests to clean up, and for `main.ts` on shutdown — though this plan doesn't touch `main.ts`'s shutdown handling, which doesn't exist yet for any other component either).

**This is the most complex task in this plan.** Design the allocation logic (`runOnce`'s core decision-making) as a separable, pure-ish function of its inputs wherever possible, per the design doc's own Testing Considerations — even though it has real side effects (calling launchers, mutating the tracker), structure the "what should happen" computation (desired counts, which models are under-provisioned, which launchers are idle, the demand-sorted claim order) as something a test can inspect independently of the async network calls that carry it out.

- [ ] **Step 1: Write the failing tests**

Read `coordinator/src/registry.ts`, `coordinator/src/reputation_tracker.ts`, and `coordinator/src/pipeline_selector.ts` fresh (all already read earlier in this session's own grounding — but re-confirm nothing has shifted) before writing test setup code, to match their exact real signatures.

Create `coordinator/tests/pipeline_pool_manager.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { PipelinePoolManager } from "../src/pipeline_pool_manager.ts";
import { PipelineTracker } from "../src/pipeline_tracker.ts";
import { DemandTracker } from "../src/demand_tracker.ts";
import { LauncherRegistry } from "../src/launcher_registry.ts";
import { NodeRegistry } from "../src/registry.ts";
import { ReputationTracker } from "../src/reputation_tracker.ts";
import { ModelCatalog, type CatalogEntry } from "../src/catalog.ts";

// A minimal stand-in for a swarm-launcher's HTTP interface: responds to
// POST /pipeline with a canned success body and counts calls; responds to
// DELETE /pipeline by counting the call and returning 204. Mirrors
// coordinator/tests/server.test.ts's own startStubNodeAgent pattern.
async function startStubLauncher() {
  let pipelineCalls = 0;
  let deleteCalls = 0;
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (req.method === "DELETE") {
      deleteCalls++;
      res.writeHead(204);
      res.end();
      return;
    }
    pipelineCalls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ready" }));
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected stub launcher to bind to a port");
  }
  return {
    server,
    endpoint: `http://127.0.0.1:${address.port}`,
    port: address.port as number,
    getPipelineCalls: () => pipelineCalls,
    getDeleteCalls: () => deleteCalls,
  };
}

function makeManager(overrides: {
  catalog?: ModelCatalog;
  registry?: NodeRegistry;
  reputation?: ReputationTracker;
  launcherRegistry?: LauncherRegistry;
  pipelineTracker?: PipelineTracker;
  demandTracker?: DemandTracker;
  random?: () => number;
}) {
  return new PipelinePoolManager(
    overrides.catalog ?? new ModelCatalog([]),
    overrides.registry ?? new NodeRegistry(),
    overrides.reputation ?? new ReputationTracker(),
    overrides.launcherRegistry ?? new LauncherRegistry(),
    overrides.pipelineTracker ?? new PipelineTracker(),
    overrides.demandTracker ?? new DemandTracker(),
    overrides.random ?? Math.random,
    30000, // intervalMs -- irrelevant for direct runOnce() calls
    300000, // idleGraceMs -- 5 minutes
  );
}

test("runOnce assembles a fresh pipeline for a model with demand, an idle launcher, and enough active nodes", async () => {
  const launcherStub = await startStubLauncher();
  try {
    const catalog = new ModelCatalog([{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 2 }]);
    const registry = new NodeRegistry();
    registry.register("http://127.0.0.1:1", "desktop");
    registry.register("http://127.0.0.1:2", "desktop");
    const launcherRegistry = new LauncherRegistry();
    launcherRegistry.register(launcherStub.endpoint, ["big-model"], launcherStub.port);
    const demandTracker = new DemandTracker();
    demandTracker.recordRequest("big-model");
    const pipelineTracker = new PipelineTracker();

    const manager = makeManager({ catalog, registry, launcherRegistry, demandTracker, pipelineTracker });
    await manager.runOnce();

    assert.equal(launcherStub.getPipelineCalls(), 1);
    assert.equal(pipelineTracker.getPool("big-model").length, 1);
    assert.equal(pipelineTracker.getPool("big-model")[0].state, "warm");
  } finally {
    launcherStub.server.close();
  }
});

test("runOnce does nothing for a model with requiredNodeCount 1", async () => {
  const launcherStub = await startStubLauncher();
  try {
    const catalog = new ModelCatalog([{ id: "small-model", displayName: "Small", minActiveNodes: 0 }]);
    const launcherRegistry = new LauncherRegistry();
    launcherRegistry.register(launcherStub.endpoint, ["small-model"], launcherStub.port);
    const demandTracker = new DemandTracker();
    demandTracker.recordRequest("small-model");

    const manager = makeManager({ catalog, launcherRegistry, demandTracker });
    await manager.runOnce();

    assert.equal(launcherStub.getPipelineCalls(), 0);
  } finally {
    launcherStub.server.close();
  }
});

test("runOnce never claims a launcher already backing a live pool entry for a DIFFERENT model", async () => {
  const launcherStub = await startStubLauncher();
  try {
    const catalog = new ModelCatalog([
      { id: "model-a", displayName: "A", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 },
      { id: "model-b", displayName: "B", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 },
    ]);
    const launcherRegistry = new LauncherRegistry();
    // The one launcher available declares it can serve BOTH models.
    const launcherId = launcherRegistry.register(launcherStub.endpoint, ["model-a", "model-b"], launcherStub.port);
    const registry = new NodeRegistry();
    registry.register("http://127.0.0.1:1", "desktop");
    registry.register("http://127.0.0.1:2", "desktop");
    const pipelineTracker = new PipelineTracker();
    // Pre-populate model-a's pool with an entry already claiming this launcher.
    pipelineTracker.addEntry("model-a", {
      pipelineId: "existing",
      driverNodeId: "http://127.0.0.1:1",
      computeNodeIds: [],
      launcherId,
      state: "warm",
      lastUsedAt: Date.now(),
    });
    const demandTracker = new DemandTracker();
    demandTracker.recordRequest("model-b");
    demandTracker.recordRequest("model-b");

    const manager = makeManager({ catalog, registry, launcherRegistry, demandTracker, pipelineTracker });
    await manager.runOnce();

    // model-b wanted a pipeline and had demand, but the only launcher
    // serving it was already claimed by model-a -- must NOT be touched.
    assert.equal(pipelineTracker.getPool("model-b").length, 0);
    assert.equal(launcherStub.getPipelineCalls(), 0); // no NEW /pipeline calls -- the pre-existing entry wasn't assembled via this stub call
  } finally {
    launcherStub.server.close();
  }
});

test("runOnce marks a pool entry failed and removes it when one of its nodes is no longer active", async () => {
  const catalog = new ModelCatalog([{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 2 }]);
  const registry = new NodeRegistry();
  const pipelineTracker = new PipelineTracker();
  pipelineTracker.addEntry("big-model", {
    pipelineId: "dead-entry",
    driverNodeId: "never-registered-node-id",
    computeNodeIds: [],
    launcherId: "some-launcher",
    state: "warm",
    lastUsedAt: Date.now(),
  });

  const manager = makeManager({ catalog, registry, pipelineTracker });
  await manager.runOnce();

  assert.equal(pipelineTracker.getPool("big-model").length, 0);
});

test("runOnce scales down a pool entry idle past the grace period, calling DELETE on its launcher", async () => {
  const launcherStub = await startStubLauncher();
  try {
    const catalog = new ModelCatalog([{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 1, maxPipelines: 1 }]);
    const registry = new NodeRegistry();
    const driverEndpoint = "http://127.0.0.1:1";
    const driverNodeId = registry.register(driverEndpoint, "desktop", undefined, "big-model");
    const launcherRegistry = new LauncherRegistry();
    const launcherId = launcherRegistry.register(launcherStub.endpoint, ["big-model"], launcherStub.port);
    const pipelineTracker = new PipelineTracker();
    const oldTimestamp = Date.now() - 400000; // well past a 300000ms (5 min) grace period
    pipelineTracker.addEntry("big-model", {
      pipelineId: "idle-entry",
      driverNodeId,
      computeNodeIds: [],
      launcherId,
      state: "warm",
      lastUsedAt: oldTimestamp,
    });
    const demandTracker = new DemandTracker(); // zero recent demand

    const manager = makeManager({ catalog, registry, launcherRegistry, pipelineTracker, demandTracker });
    await manager.runOnce();

    assert.equal(launcherStub.getDeleteCalls(), 1);
    assert.equal(pipelineTracker.getPool("big-model").length, 0);
  } finally {
    launcherStub.server.close();
  }
});

test("runOnce allocates a single idle launcher to the higher-demand of two competing under-provisioned models", async () => {
  const launcherStub = await startStubLauncher();
  try {
    const catalog = new ModelCatalog([
      { id: "model-low", displayName: "Low", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 },
      { id: "model-high", displayName: "High", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 1 },
    ]);
    const registry = new NodeRegistry();
    registry.register("http://127.0.0.1:1", "desktop");
    registry.register("http://127.0.0.1:2", "desktop");
    const launcherRegistry = new LauncherRegistry();
    // ONE launcher declares it can serve BOTH models -- only one of them
    // can actually get it this tick.
    launcherRegistry.register(launcherStub.endpoint, ["model-low", "model-high"], launcherStub.port);
    const demandTracker = new DemandTracker();
    demandTracker.recordRequest("model-low");
    for (let i = 0; i < 5; i++) demandTracker.recordRequest("model-high");
    const pipelineTracker = new PipelineTracker();

    const manager = makeManager({ catalog, registry, launcherRegistry, demandTracker, pipelineTracker });
    await manager.runOnce();

    assert.equal(pipelineTracker.getPool("model-high").length, 1);
    assert.equal(pipelineTracker.getPool("model-low").length, 0);
  } finally {
    launcherStub.server.close();
  }
});

- [ ] **Step 2: Confirm the tests fail**

Run: `cd coordinator && npm test -- --test-name-pattern="runOnce"`
Expected: FAIL — `Cannot find module '../src/pipeline_pool_manager.ts'`.

- [ ] **Step 3: Create `coordinator/src/pipeline_pool_manager.ts`**

```typescript
import { randomUUID } from "node:crypto";
import type { NodeRegistry } from "./registry.ts";
import type { ReputationTracker } from "./reputation_tracker.ts";
import type { ModelCatalog } from "./catalog.ts";
import { LauncherRegistry } from "./launcher_registry.ts";
import { PipelineTracker } from "./pipeline_tracker.ts";
import type { DemandTracker } from "./demand_tracker.ts";
import { selectPipeline } from "./pipeline_selector.ts";

// Deliberately naive per the design doc's own explicit instruction not to
// over-engineer a scaling function without real load data: one pipeline
// per REQUESTS_PER_PIPELINE requests/minute of recent demand.
const REQUESTS_PER_PIPELINE = 10;

const PIPELINE_ASSEMBLY_TIMEOUT_MS = 60000;

export class PipelinePoolManager {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly catalog: ModelCatalog,
    private readonly registry: NodeRegistry,
    private readonly reputation: ReputationTracker,
    private readonly launcherRegistry: LauncherRegistry,
    private readonly pipelineTracker: PipelineTracker,
    private readonly demandTracker: DemandTracker,
    private readonly random: () => number = Math.random,
    private readonly intervalMs: number = 30000,
    private readonly idleGraceMs: number = 300000,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.runOnce().catch(err => console.warn("pipeline pool reconciliation failed:", err));
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async runOnce(): Promise<void> {
    const modelIds = this.catalog.multiPipelineModelIds();
    await this.healthCheckAndScaleDown(modelIds);
    await this.allocate(modelIds);
  }

  // Step 1: drop any pool entry whose node set is no longer fully active,
  // and any entry idle past the grace period -- both free their
  // launcherId for reallocation below, in the SAME tick they're freed
  // (allocate() re-derives "claimed" state fresh from the tracker every
  // call, so a launcher freed here is immediately eligible).
  private async healthCheckAndScaleDown(modelIds: string[]): Promise<void> {
    const activeNodeIds = new Set(this.registry.listActive(this.reputation).map(n => n.nodeId));
    const now = Date.now();

    for (const modelId of modelIds) {
      for (const entry of [...this.pipelineTracker.getPool(modelId)]) {
        const allNodesActive = [entry.driverNodeId, ...entry.computeNodeIds].every(id => activeNodeIds.has(id));
        if (!allNodesActive) {
          this.pipelineTracker.removeEntry(modelId, entry.pipelineId);
          continue;
        }
        if (now - entry.lastUsedAt > this.idleGraceMs) {
          await this.tryStopLauncher(entry.launcherId);
          this.pipelineTracker.removeEntry(modelId, entry.pipelineId);
        }
      }
    }
  }

  private async tryStopLauncher(launcherId: string): Promise<void> {
    const launcher = this.launcherRegistry.listActive().find(l => l.launcherId === launcherId);
    if (!launcher) {
      return; // launcher itself is gone -- nothing to call, nothing left to clean up
    }
    try {
      await fetch(`${launcher.endpoint}/pipeline`, {
        method: "DELETE",
        signal: AbortSignal.timeout(PIPELINE_ASSEMBLY_TIMEOUT_MS),
      });
    } catch (err) {
      console.warn(`failed to stop idle pipeline on launcher ${launcher.endpoint}:`, err);
    }
  }

  // Step 2: for every model whose current pool size is below its desired
  // count, try to claim a genuinely idle launcher for it -- genuinely
  // idle meaning not the launcherId of ANY pool entry for ANY model right
  // now, checked fresh each iteration since a claim earlier in this same
  // pass changes what's available for a later one. Models are visited in
  // demand-sorted (descending) order, and a launcher already backing a
  // live pipeline is never preempted -- see this plan's Global Constraints.
  private async allocate(modelIds: string[]): Promise<void> {
    const wanting = modelIds
      .map(modelId => ({ modelId, demand: this.demandTracker.recentDemand(modelId) }))
      .filter(({ modelId }) => this.desiredCount(modelId) > this.pipelineTracker.getPool(modelId).length)
      .sort((a, b) => b.demand - a.demand);

    for (const { modelId } of wanting) {
      while (this.desiredCount(modelId) > this.pipelineTracker.getPool(modelId).length) {
        const claimedLauncherIds = new Set(
          modelIds.flatMap(id => this.pipelineTracker.getPool(id).map(e => e.launcherId)),
        );
        const idleLauncher = this.launcherRegistry
          .listForModel(modelId)
          .find(l => !claimedLauncherIds.has(l.launcherId));
        if (!idleLauncher) {
          break; // no idle launcher available for this model right now -- try again next tick
        }
        const assembled = await this.tryAssemble(modelId, idleLauncher.launcherId, idleLauncher.endpoint, idleLauncher.agentPort);
        if (!assembled) {
          break; // assembly failed (not enough active nodes, launcher error) -- don't spin on the same model this tick
        }
      }
    }
  }

  private desiredCount(modelId: string): number {
    if (this.catalog.requiredNodeCount(modelId) <= 1) {
      return 0; // Task 1/Task 4's own guard, restated here: a model that doesn't need a multi-node pipeline never engages this pool at all
    }
    const demand = this.demandTracker.recentDemand(modelId);
    const naive = Math.ceil(demand / REQUESTS_PER_PIPELINE);
    return Math.max(1, Math.min(naive, this.catalog.maxPipelines(modelId)));
  }

  private async tryAssemble(modelId: string, launcherId: string, launcherEndpoint: string, agentPort: number): Promise<boolean> {
    const requiredNodeCount = this.catalog.requiredNodeCount(modelId);
    const selection = selectPipeline(this.registry.listActive(this.reputation), this.reputation, requiredNodeCount, this.random);
    if (!selection) {
      return false;
    }
    try {
      const toHostPort = (endpoint: string) => endpoint.replace(/^https?:\/\//, "");
      const remoteEndpoints = selection.computeContributors.map(n => toHostPort(n.endpoint)).join(",");
      const res = await fetch(`${launcherEndpoint}/pipeline`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: modelId, remoteEndpoints, layerPlacements: "" }),
        signal: AbortSignal.timeout(PIPELINE_ASSEMBLY_TIMEOUT_MS),
      });
      if (!res.ok) {
        return false;
      }
      const launcherUrl = new URL(launcherEndpoint);
      const driverEndpoint = `${launcherUrl.protocol}//${launcherUrl.hostname}:${agentPort}`;
      const driverNodeId = this.registry.register(driverEndpoint, "desktop", undefined, modelId);
      this.pipelineTracker.addEntry(modelId, {
        pipelineId: randomUUID(),
        driverNodeId,
        computeNodeIds: selection.computeContributors.map(n => n.nodeId),
        launcherId,
        state: "warm",
        lastUsedAt: Date.now(),
      });
      return true;
    } catch (err) {
      console.warn(`failed to assemble pipeline for model ${modelId} via launcher ${launcherEndpoint}:`, err);
      return false;
    }
  }
}
```

- [ ] **Step 4: Add `ModelCatalog.multiPipelineModelIds()`**

`pipeline_pool_manager.ts` above calls `this.catalog.multiPipelineModelIds()`, which doesn't exist yet. Read the current `coordinator/src/catalog.ts` (as Task 1 left it) and find:

```typescript
  maxPipelines(id: string): number {
    return this.entries.find(entry => entry.id === id)?.maxPipelines ?? 1;
  }
```

Replace with:

```typescript
  maxPipelines(id: string): number {
    return this.entries.find(entry => entry.id === id)?.maxPipelines ?? 1;
  }

  // Every catalog entry id whose requiredNodeCount is declared > 1 --
  // the only models the pool manager (Phase C) ever considers, since a
  // requiredNodeCount:1 model never needs launcher-backed pipeline
  // assembly at all (Phase B's own guard, restated at the catalog level
  // so the pool manager doesn't need its own copy of this filtering
  // logic).
  multiPipelineModelIds(): string[] {
    return this.entries.filter(entry => (entry.requiredNodeCount ?? 1) > 1).map(entry => entry.id);
  }
```

- [ ] **Step 5: Add a matching test for `multiPipelineModelIds()` in `coordinator/tests/catalog.test.ts`**

```typescript
test("multiPipelineModelIds returns only entries with requiredNodeCount > 1", () => {
  const catalog = new ModelCatalog([
    { id: "small", displayName: "Small", minActiveNodes: 0 },
    { id: "big", displayName: "Big", minActiveNodes: 5, requiredNodeCount: 3 },
    { id: "also-small", displayName: "Also Small", minActiveNodes: 0, requiredNodeCount: 1 },
  ]);
  assert.deepEqual(catalog.multiPipelineModelIds(), ["big"]);
});
```

- [ ] **Step 6: Run all the new tests**

Run: `cd coordinator && npm test -- --test-name-pattern="runOnce|multiPipelineModelIds"`
Expected: PASS (all 6 `pipeline_pool_manager.test.ts` tests + 1 `catalog.test.ts` test green).

- [ ] **Step 7: Run the full coordinator suite (regression check)**

Run: `cd coordinator && npm test`
Expected: PASS, all tests. Baseline after Task 5 is 306; expect 313 (306 + 6 pool-manager tests + 1 catalog test).

- [ ] **Step 8: Commit**

```bash
git add coordinator/src/pipeline_pool_manager.ts coordinator/src/catalog.ts coordinator/tests/pipeline_pool_manager.test.ts coordinator/tests/catalog.test.ts
git commit -m "Add PipelinePoolManager: background reconciliation loop for demand-based pipeline pooling"
```

---

### Task 7: `POST /generate` pool-first routing integration

**Files:**
- Modify: `coordinator/src/server.ts`
- Modify: `coordinator/src/main.ts`
- Test: `coordinator/tests/server.test.ts`

**Interfaces:**
- Consumes: Task 3's `DemandTracker`, Task 4's `PipelineTracker` pool API, Task 6's `PipelinePoolManager` (wired into `main.ts` only, not into `createServer`'s own request-handling — the reconciliation loop and the request path are independent; `/generate` just reads whatever pool state exists at request time).
- Produces: nothing consumed by a later task — this is the last task in this plan.

Read the CURRENT `coordinator/src/server.ts` and `coordinator/src/main.ts` in full before writing this task's exact Find/Replace blocks — Task 4 already changed `ensurePipelineReady`'s internals and `createServer`'s call sites in ways this task must build on precisely, not from memory.

- [ ] **Step 1: Write the failing tests**

Add these tests to `coordinator/tests/server.test.ts`, near the existing Phase B pipeline-assembly tests:

```typescript
test("POST /generate spreads requests across a warm pool with more than one entry (least-recently-used)", async () => {
  const stubA = await startStubNodeAgent(() => ({ status: 200, body: { text: "from driver A" } }));
  const stubB = await startStubNodeAgent(() => ({ status: 200, body: { text: "from driver B" } }));
  const bigCatalog = [{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 1, maxPipelines: 2 }];
  const { server, baseUrl, registry, pipelineTracker } = await startTestServer(bigCatalog);
  try {
    const driverA = registry.register(stubA.endpoint, "desktop", undefined, "big-model");
    const driverB = registry.register(stubB.endpoint, "desktop", undefined, "big-model");
    pipelineTracker.addEntry("big-model", { pipelineId: "p1", driverNodeId: driverA, computeNodeIds: [], launcherId: "l1", state: "warm", lastUsedAt: Date.now() });
    pipelineTracker.addEntry("big-model", { pipelineId: "p2", driverNodeId: driverB, computeNodeIds: [], launcherId: "l2", state: "warm", lastUsedAt: Date.now() });

    const texts = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const res = await authFetch(`${baseUrl}/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "hi", modelId: "big-model" }),
      });
      const body = await res.json();
      texts.add(body.text);
    }
    // Round-robin across 2 entries over 4 requests must have used both.
    assert.deepEqual(texts, new Set(["from driver A", "from driver B"]));
  } finally {
    server.close();
    stubA.server.close();
    stubB.server.close();
  }
});

test("POST /generate updates a pool entry's lastUsedAt when it's used", async () => {
  const stub = await startStubNodeAgent(() => ({ status: 200, body: { text: "hi" } }));
  const bigCatalog = [{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 1, maxPipelines: 1 }];
  const { server, baseUrl, registry, pipelineTracker } = await startTestServer(bigCatalog);
  try {
    const driverNodeId = registry.register(stub.endpoint, "desktop", undefined, "big-model");
    pipelineTracker.addEntry("big-model", { pipelineId: "p1", driverNodeId, computeNodeIds: [], launcherId: "l1", state: "warm", lastUsedAt: 0 });

    await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "big-model" }),
    });

    const entry = pipelineTracker.getPool("big-model").find(e => e.pipelineId === "p1");
    assert.ok(entry && entry.lastUsedAt > 0);
  } finally {
    server.close();
    stub.server.close();
  }
});

test("POST /generate with a non-empty pool never calls ensurePipelineReady's launcher-assembly path", async () => {
  const stub = await startStubNodeAgent(() => ({ status: 200, body: { text: "from the pool" } }));
  let launcherCalls = 0;
  const launcherStub = await startStubNodeAgent(() => {
    launcherCalls++;
    return { status: 200, body: { status: "ready" } };
  });
  const bigCatalog = [{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 2 }];
  const { server, baseUrl, registry, pipelineTracker, launcherRegistry } = await startTestServer(bigCatalog);
  try {
    const driverNodeId = registry.register(stub.endpoint, "desktop", undefined, "big-model");
    pipelineTracker.addEntry("big-model", { pipelineId: "p1", driverNodeId, computeNodeIds: [], launcherId: "l1", state: "warm", lastUsedAt: Date.now() });
    launcherRegistry.register(launcherStub.endpoint, ["big-model"], Number(new URL(launcherStub.endpoint).port));

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "big-model" }),
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "from the pool" });
    assert.equal(launcherCalls, 0);
  } finally {
    server.close();
    stub.server.close();
    launcherStub.server.close();
  }
});

test("POST /generate falls back to ensurePipelineReady's cold-start assembly when the pool is empty", async () => {
  // This is the existing Phase B "assembles a fresh pipeline" behavior --
  // confirming Task 7's new pool-first check doesn't disturb it when
  // there's genuinely nothing in the pool yet.
  let capturedLauncherRequest: Record<string, unknown> | undefined;
  const stub = await startStubNodeAgent((body) => {
    const candidate = body as Record<string, unknown>;
    if (candidate.model !== undefined) {
      capturedLauncherRequest = candidate;
      return { status: 200, body: { status: "ready" } };
    }
    return { status: 200, body: { text: "from the cold-start driver" } };
  });
  const bigCatalog = [{ id: "big-model", displayName: "Big", minActiveNodes: 0, requiredNodeCount: 2, maxPipelines: 2 }];
  const { server, baseUrl, launcherRegistry, registry } = await startTestServer(bigCatalog);
  try {
    registry.register("http://127.0.0.1:1", "desktop");
    registry.register("http://127.0.0.1:2", "desktop");
    launcherRegistry.register(stub.endpoint, ["big-model"], Number(new URL(stub.endpoint).port));

    const res = await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "big-model" }),
    });

    assert.equal(capturedLauncherRequest?.model, "big-model");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: "from the cold-start driver" });
  } finally {
    server.close();
    stub.server.close();
  }
});

test("POST /generate records demand for every request via the DemandTracker", async () => {
  const stub = await startStubNodeAgent(() => ({ status: 200, body: { text: "Paris." } }));
  const { server, baseUrl, registry, demandTracker } = await startTestServer();
  try {
    await authFetch(`${baseUrl}/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: stub.endpoint, deviceTier: "desktop", servesModel: "tinyllama-1.1b" }),
    });
    await authFetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi", modelId: "tinyllama-1.1b" }),
    });
    assert.equal(demandTracker.recentDemand("tinyllama-1.1b"), 1);
  } finally {
    server.close();
    stub.server.close();
  }
});
```

- [ ] **Step 2: Confirm the tests fail**

Run: `cd coordinator && npm test -- --test-name-pattern="round-robin|lastUsedAt|never calls ensurePipelineReady|falls back to ensurePipelineReady|records demand"`
Expected: FAIL — `startTestServer` doesn't accept/return a `demandTracker` yet, and `/generate` has no pool-first check yet.

- [ ] **Step 3: Extend `startTestServer` in `coordinator/tests/server.test.ts` to support `DemandTracker`**

Read the current `startTestServer` (as Task 4 left it — 8 parameters, returns `{ server, baseUrl, registry, peers, reputation, authToken, launcherRegistry, pipelineTracker }`). Add `demandTracker` as a new 9th parameter with a default, threaded into `createServer(...)` and the returned object, following the exact same pattern as every prior parameter addition to this helper in this project's history (Task 5 added `launcherRegistry` this way, Task 5-of-Task-7-predecessor added `pipelineTracker` this way).

Add the import: `import { DemandTracker } from "../src/demand_tracker.ts";`

- [ ] **Step 4: Add `demandTracker` to `createServer(...)`'s signature in `coordinator/src/server.ts`**

Find the current `createServer(...)` signature (as Task 4 left it — read the file fresh to confirm its exact current parameter list) and add `demandTracker: DemandTracker = new DemandTracker()` as a new trailing parameter with a default, matching every prior addition's pattern (a trailing optional parameter never breaks an existing call site).

Add the import: `import { DemandTracker } from "./demand_tracker.ts";`

- [ ] **Step 5: Add pool-first routing to `/generate`**

Find (the line immediately before `ensurePipelineReady`'s existing call — read the file fresh to confirm exact current surrounding text):

```typescript
        await ensurePipelineReady(candidate.modelId, catalog, registry, reputation, launcherRegistry, pipelineTracker, authToken, random);
        const node = selectNode(registry.listActive(reputation), reputation, candidate.modelId, random);
        if (!node) {
          sendJson(res, 503, { error: `no active node currently serves model "${candidate.modelId}"` });
          return;
        }
```

Replace with:

```typescript
        demandTracker.recordRequest(candidate.modelId);

        let node: NodeInfo | undefined;
        const pool = pipelineTracker.getPool(candidate.modelId).filter(entry => entry.state === "warm");
        if (pool.length > 0) {
          // Least-recently-used selection: pick whichever warm entry has
          // gone longest without serving a request. Reuses the same
          // lastUsedAt field scale-down (Task 6) already needs to track
          // for its own idle-grace-period check, rather than adding a
          // separate round-robin counter per model -- swarm-node-agent
          // serves one request at a time anyway (documented, unchanged
          // limitation), so this spreads load just as evenly as a
          // counter would, for less state.
          const entry = pool.reduce((oldest, candidate) => candidate.lastUsedAt < oldest.lastUsedAt ? candidate : oldest);
          entry.lastUsedAt = Date.now();
          node = registry.listActive(reputation).find(n => n.nodeId === entry.driverNodeId);
        }
        if (!node) {
          // Cold-start fallback: no warm pool entry (or the one pool
          // entry's driver has since dropped out of the registry, in
          // which case the next reconciliation tick will prune it --
          // this request just falls through here instead of waiting for
          // that). Assembles at most one pipeline synchronously, exactly
          // as Phase B's existing behavior does.
          await ensurePipelineReady(candidate.modelId, catalog, registry, reputation, launcherRegistry, pipelineTracker, authToken, random);
          node = selectNode(registry.listActive(reputation), reputation, candidate.modelId, random);
        }
        if (!node) {
          sendJson(res, 503, { error: `no active node currently serves model "${candidate.modelId}"` });
          return;
        }
```

`NodeInfo` is already imported at the top of `server.ts` (`import { NodeRegistry, type DeviceTier, type NodeInfo } from "./registry.ts";`) — no new import needed.

- [ ] **Step 6: Wire `DemandTracker`/`PipelinePoolManager` into `coordinator/src/main.ts`**

Read the current `main.ts` in full to find where `NodeRegistry`/`ReputationTracker`/`LauncherRegistry`/`PipelineTracker` are already constructed and passed to `createServer(...)`. Add a `DemandTracker` instance and a `PipelinePoolManager` instance (constructed with the same shared `catalog`/`registry`/`reputation`/`launcherRegistry`/`pipelineTracker`/`demandTracker` instances `createServer` already uses), pass `demandTracker` as `createServer`'s new trailing argument, and call `poolManager.start()` once, after the server begins listening (matching wherever this file's own existing startup-logging/readiness pattern is, if any — read it fresh rather than assuming).

- [ ] **Step 7: Run the new tests**

Run: `cd coordinator && npm test -- --test-name-pattern="round-robin|lastUsedAt|never calls ensurePipelineReady|falls back to ensurePipelineReady|records demand"`
Expected: PASS (all 5 new tests green).

- [ ] **Step 8: Run the full coordinator suite (regression check)**

Run: `cd coordinator && npm test`
Expected: PASS, all tests. Baseline after Task 6 is 313; expect 318. Every existing `/generate` test (for both `requiredNodeCount:1` and the Phase B `requiredNodeCount>1` cold-start scenarios) must pass with identical observable behavior — this task's new pool-first branch only ever engages when `pipelineTracker.getPool(modelId)` already has a `"warm"` entry, which none of Phase B's own existing tests populate ahead of time (they all start from an empty pool, exactly like today).

- [ ] **Step 9: Commit**

```bash
git add coordinator/src/server.ts coordinator/src/main.ts coordinator/tests/server.test.ts
git commit -m "Wire pool-first round-robin routing into POST /generate, falling back to cold-start assembly"
```

---

## What This Plan Does Not Do

Named explicitly, per this project's established scoping convention:

- **Cross-instance (federated) autoscaling coordination** — this instance's pool manager has no visibility into what a peer coordinator is doing with launchers that might also be reachable from there. Matches the design doc's own Non-Goal.
- **A real, validated scaling function.** `REQUESTS_PER_PIPELINE = 10` and the 5-minute idle grace period are unvalidated starting points, not load-tested — matching the design doc's own explicit instruction not to over-engineer this without real traffic data.
- **Demand-based preemption of an already-claimed launcher.** Resolved explicitly with the user: a launcher backing a live pipeline is never killed to give its slot to a busier model. A model that briefly spiked early can hold launcher capacity a now-busier model can't get, until its own scale-down/grace-period logic frees it naturally. Disclosed, not solved.
- **`/v1/chat/completions`'s own node selection** — this plan only touches `/generate`'s routing, matching Phase B's own precedent of leaving the OpenAI-compatible endpoint's separate `selectNode(...)` call site untouched.
- **Coordinator restart resilience for pool/demand state.** Both `PipelineTracker` and `DemandTracker` are in-memory only, same disclosed posture as every other piece of state in this coordinator — a restart loses all pool/demand history and the pool manager rebuilds from an empty state on its next few reconciliation ticks.
- **A live-adversarial-probing whole-branch review including a real multi-launcher, multi-model contention scenario** (two+ real `swarm-launcher` processes, two+ catalog models both wanting pipelines, confirming the demand-sorted allocation and no-preemption guarantee hold against real processes, not just the unit-level pure-function tests in Task 6) — required before merge, per this plan's Global Constraints and the design doc's Testing Considerations, matching this project's established, repeatedly-validated practice that reading-only review has never once caught what live probing catches.
- **Updating `README.md`/`CLAUDE.md`** — happens after merge, per `ddc-plan-workflow`'s established "After Merge" step, not as one of this plan's own tasks.
