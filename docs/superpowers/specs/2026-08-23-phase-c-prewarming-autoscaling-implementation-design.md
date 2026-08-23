# Phase C: Background Pre-Warming & Demand-Based Autoscaling — Implementation Design

## Background

This supersedes/elaborates the original forward-looking sketch at
[`docs/superpowers/specs/2026-08-16-phase-c-prewarming-autoscaling-design.md`](docs/superpowers/specs/2026-08-16-phase-c-prewarming-autoscaling-design.md),
written before Phase B (or Phases A/D, or any of the Security Hardening
initiative) existed. That doc's Summary and Goals are still sound — closing
the gap where `/catalog` reports a model "available" based on raw node
count with no warm pipeline actually behind it, and growing/shrinking the
number of concurrent warm pipelines per model with observed demand — but
its Architecture section assumed a shape for Phase B that isn't what
actually shipped, and it doesn't grapple with a constraint that only became
visible once Phase B's real code existed. This doc grounds every claim
against the real current source (`coordinator/src/pipeline_tracker.ts`,
`pipeline_selector.ts`, `launcher_registry.ts`, `catalog.ts`, `server.ts`'s
`ensurePipelineReady()`, `core/src/launcher_main.cpp` — all read fresh as
of 2026-08-23, not from memory).

**Two things the original sketch got wrong or didn't anticipate, resolved
here rather than carried forward:**

1. **`PipelineTracker` is a single-slot-per-model structure today**
   (`Map<modelId, TrackedPipeline>` — exactly one tracked pipeline per
   model, by explicit design; its own code comment says multiple concurrent
   pipelines per model is Phase C's problem). The original doc's
   `count_warm_pipelines(model)` pseudocode assumed this could already
   return more than 1. It can't. Phase C has to change this data structure,
   not just add a loop on top of it.
2. **One launcher hosts exactly one concurrent pipeline, for any model,
   full stop.** Read fresh: `core/src/launcher_main.cpp` holds a single
   `std::unique_ptr<SpawnedProcess> currentAgent` — spawning a new pipeline
   (even for a *different* model) always kills whatever the launcher was
   already running. The original doc's Architecture section says "assemble
   additional pipelines via Phase B's launcher mechanism" as if launchers
   are a freely-multiplexable resource; they are the opposite — a scarce,
   single-slot resource shared across *every* model in the catalog, not a
   per-model pool of capacity. Scaling model X's pipeline count from 1 to 3
   means finding 3 distinct, currently-idle launcher machines and
   allocating them to X specifically, in competition with every other model
   that also wants launcher capacity. This is the central new design
   problem Phase C actually has to solve, and the original doc doesn't
   mention it at all.

One claim in the original doc's Testing Considerations — a cross-reference
to "Plan 13's whole-branch review" proving an in-flight request survives
its node being reputation-ejected mid-flight — could not be verified
against this project's actual history (plans run 1–11, then
lettered/numbered phases; there is no Plan 13) and is treated here as
unverified, not as settled precedent.

Phase A (manual pipeline composition), Phase B (dynamic pipeline assembly),
and Phase D (token streaming) are all done and merged. This is the last
phase in the request routing initiative.

## Goals

(Unchanged from the original doc.)

- Reconcile `/catalog`'s `available` flag with reality: a model should show
  `available: true` only when a warm, request-ready pipeline actually
  exists for it (or can be assembled fast enough not to matter), not
  merely when enough raw node count is registered.
- Track demand per model (recent/concurrent request volume) and use it to
  decide how many warm pipelines to keep for that model, within whatever
  launcher capacity is currently available and not already claimed by
  another model.
- Handle pipeline churn — a node in a warm pipeline gets reputation-ejected
  or ages out of the registry — by triggering reassembly proactively,
  before the next request discovers the pipeline is broken.

**Resolved explicitly with the user rather than assumed:** Phase C targets
the full multi-pipeline autoscaling pool (not a narrower single-pipeline
pre-warming-only slice), and launcher allocation across competing models
uses **demand-sorted claiming with no preemption** — a launcher already
hosting a live pipeline for one model is never killed just because another
model's demand rose; it only becomes reallocatable once its own
model's scale-down/grace-period logic frees it naturally. This was chosen
over a cache-eviction-style preemption scheme specifically to avoid
interrupting a live pipeline at an unpredictable moment for a first
version, matching this project's own established "ship something simple,
don't over-engineer without real load data" posture (the original doc's own
stated position on the demand-to-pipeline-count scaling function, applied
here to the allocation problem too).

## Non-Goals

(Unchanged from the original doc, plus one addition made explicit by this
pass.)

- **Deciding which specific nodes go into a pipeline** — that's Phase B's
  scoring problem (`pipeline_selector.ts`'s `selectPipeline()`), reused
  unchanged here.
- **Token streaming** — Phase D, unrelated axis.
- **Cross-instance (federated) autoscaling** — this repo's federation layer
  shares capacity *counts* between coordinator instances; Phase C as scoped
  here only manages this instance's own pipeline pool. Extending
  autoscaling decisions across federated instances is a materially harder
  problem (whose pipeline serves a given request when multiple instances
  could) and explicitly out of scope.
- **A general job-scheduling system.** Phase C is specifically about LLM
  inference pipelines, not a reusable abstraction for scheduling arbitrary
  work across the swarm.
- **Preemptive reallocation of an already-claimed launcher.** Made explicit
  by this pass, not present in the original doc: once a launcher is hosting
  a live pipeline for model A, Phase C never kills it to give its slot to
  model B, no matter how much B's demand has grown. A launcher only becomes
  reallocatable via A's own scale-down/grace-period/reassembly-on-ejection
  paths. This is a real limitation under sustained demand skew (a model
  that briefly spiked early can permanently hold launcher capacity a
  now-busier model can't get), disclosed below, not solved here.

## Architecture

### 1. Pool data model (`coordinator/src/pipeline_tracker.ts`, rewritten)

Read fresh: `PipelineTracker` today is `Map<modelId, TrackedPipeline>`
where `TrackedPipeline` is `{driverNodeId?, computeNodeIds, state: "warm" |
"failed"}`. Becomes:

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
```

`Map<modelId, PooledPipeline[]>`, with methods covering the same shape of
operations the single-slot version had, generalized to a list: `getPool(modelId): PooledPipeline[]` (returns `[]` for a model with no
entries — never `undefined`, so callers don't need an extra null check),
`addEntry(modelId, entry: PooledPipeline): void`, `removeEntry(modelId, pipelineId): void`, and `markEntryFailed(modelId, pipelineId): void`. `PipelineTracker`'s old
single-slot `get`/`markWarm`/`markFailed` methods are removed entirely (not
kept alongside the new ones) — every caller moves to the pool-shaped API,
consistent with the Rejected Approaches note below about not maintaining
two parallel code paths for "one pipeline" versus "more than one."

Tracking `launcherId` per entry is new
and load-bearing: it's how the reconciliation loop (#4) determines which
launchers are already claimed versus idle — Phase B's `ensurePipelineReady`
never needed this, since it always called `launcherRegistry.findForModel()`
fresh with no concept of "already spoken for." `lastUsedAt` (updated on
every `/generate` request routed through this pool entry) drives both the
idle-grace-period scale-down check and round-robin/least-recently-used
selection at request time (#5).

`pipelineId` (a `randomUUID()`, matching this project's existing pattern in
`LauncherRegistry`/`PeerRegistry`) gives each pool entry an explicit,
stable identity independent of which node currently happens to be its
driver. `driverNodeId` would in practice stay unique across one model's
pool entries too (each entry is backed by a distinct launcher, and
`NodeRegistry`'s `stableNodeId()` hashes the launcher's own
host:agentPort, so distinct launchers always produce distinct driver
node IDs) — but relying on that as the array key would make "this pool
entry got reassembled onto a new driver" indistinguishable from "this
pool entry was replaced by an unrelated one," and an explicit ID matches
this project's own established pattern of giving every tracked entity
(launcher, peer, node) its own identity rather than deriving one
incidentally.

### 2. Per-model pool cap (`coordinator/src/catalog.ts`)

One new optional field: `maxPipelines?: number` — default `1` when absent,
so every existing catalog entry (all of which already default to
`requiredNodeCount: 1`) keeps a single-pipeline ceiling and Phase C's
scaling logic never grows their pool past what Phase B already did
synchronously. Only a catalog entry that explicitly sets both
`requiredNodeCount > 1` (Phase B's own gate — a model needs a
multi-node pipeline at all) and `maxPipelines > 1` engages the new
pool-scaling machinery end to end.

### 3. Demand tracking (`coordinator/src/demand_tracker.ts`, new)

A small, pure-ish class: `recordRequest(modelId: string): void` (called
once per `/generate`/`/v1/chat/completions` request, alongside the
existing classify step) and `recentDemand(modelId: string): number`
(request count in the trailing 60-second window, per the original doc's
own proposal — adopted unchanged). Implementation: a `Map<modelId,
number[]>` of request timestamps, pruned lazily on read (same style as
`NodeRegistry`'s own prune-on-iterate pattern). In-memory only, matching
every other piece of state in this coordinator — a coordinator restart
loses demand history and starts the window fresh, same disclosed posture
as `NodeRegistry`/`ReputationTracker`/`PeerRegistry`.

### 4. Reconciliation loop (`coordinator/src/pipeline_pool_manager.ts`, new)

A `PipelinePoolManager` class wrapping a `setInterval`-driven loop (30
seconds, tunable via a constructor parameter — matching
`NodeRegistry`/`ReputationTracker`'s existing injectable-parameter
pattern for testability, so a test can inject a short interval or drive
the loop's core logic directly without waiting on a real timer). Each
tick, for every catalog entry with `requiredNodeCount > 1`:

1. **Health check existing pool entries.** For each `PooledPipeline` in
   this model's pool, check whether every node in
   `[driverNodeId, ...computeNodeIds]` is still present in
   `registry.listActive(reputation)`. If any isn't, mark that one entry
   `"failed"` and remove it from the pool (freeing its `launcherId`) —
   this is what turns a reputation-ejection or heartbeat-timeout into a
   background-healed condition instead of the next request discovering a
   `502`.
2. **Scale down.** For any remaining `"warm"` entry whose `lastUsedAt` is
   older than the idle grace period (5 minutes, tunable), tear it down and
   remove it from the pool, freeing its `launcherId` for reallocation.
   **This step has no real mechanism to call yet** — `swarm-launcher`'s
   only endpoint, `POST /pipeline`, spawns a *new* agent; there is no way
   to ask it to just stop with no replacement. See Open Questions: the
   implementation plan needs to add a real "stop"/"idle" capability to the
   launcher before this step can do anything beyond removing the
   coordinator's own bookkeeping (which alone would incorrectly free the
   `launcherId` for reallocation while the old agent is still actually
   running and holding the port).
3. **Compute desired count.** `desired = min(maxPipelines, scalingFunction(demandTracker.recentDemand(modelId)))`. The scaling function is
   deliberately naive per the original doc's own explicit instruction not
   to over-engineer this without real load data: `Math.ceil(recentDemand /
   REQUESTS_PER_PIPELINE)` where `REQUESTS_PER_PIPELINE` is a constant
   (starting value: 10 — i.e. one pipeline per 10 requests/minute of
   recent demand), clamped to `[1, maxPipelines]` whenever
   `requiredNodeCount > 1` (a model that needs a multi-node pipeline at
   all always wants at least one warm, matching Phase B's own "assemble on
   first request" behavior as the floor, never zero).
4. **Allocate.** After every model's current/desired counts are known for
   this tick, build the list of `(modelId, additionalPipelinesWanted)`
   pairs where `desired > current`, sort by
   `demandTracker.recentDemand(modelId)` descending, and walk it in that
   order: for each model, while it still wants more and
   `launcherRegistry.listForModel(modelId)` (#6, new — every active
   launcher declaring this model in its own `servesModels`) has an entry
   whose `launcherId` isn't already present as some pool entry's
   `launcherId` anywhere (i.e., genuinely idle, checked across *all*
   models' pools, not just this one), claim it — call
   `pipeline_selector.ts`'s existing `selectPipeline()` for compute
   contributors, call that launcher's `POST /pipeline`, and on success add
   a new `PooledPipeline` entry. This is the demand-sorted-claiming,
   no-preemption policy resolved with the user above: a launcher already
   present as *any* pool entry's `launcherId` (for this model or any
   other) is never touched here, no matter how it ranks.

### 5. `/generate` integration (`coordinator/src/server.ts`)

`ensurePipelineReady()` is renamed conceptually but not necessarily in
code to reflect its narrower new role: it becomes the **cold-start
fallback**, called only when the model's pool (from `PipelineTracker`) is
empty for this request. The new happy path, inserted before the existing
`ensurePipelineReady()` call:

```typescript
const pool = pipelineTracker.getPool(candidate.modelId); // §1's new pool-shaped API
if (pool.length > 0) {
  const entry = pickRoundRobin(pool, candidate.modelId); // simplest thing that spreads load
  entry.lastUsedAt = Date.now();
  // route to entry.driverNodeId via the existing selectNode-adjacent path
} else {
  await ensurePipelineReady(...); // today's Phase B synchronous fallback, unchanged
  // then selectNode(...) as today
}
```

**Corrected during plan-writing** (this doc originally specified
round-robin here; the plan implements least-recently-used instead, for a
concrete reason worth recording): least-recently-used is the selection
policy, using the same `lastUsedAt` field #4's scale-down step already has
to track for its own idle-grace-period check — a genuinely simpler
implementation than a separate round-robin counter per model, not a
weaker one. Since `swarm-node-agent` serves one request at a time anyway
(documented, unchanged limitation), LRU and round-robin spread load just
as evenly for this project's actual bottleneck. `getPool()`
on `PipelineTracker` returns only entries the reconciliation loop's own
health check (#4.1) has already confirmed live as of the last tick — a
pool entry whose node died between reconciliation ticks still gets a
`502` from `/generate`'s own forwarding call, exactly like today's Phase B
behavior, and that failure is what the *next* reconciliation tick's health
check will catch and heal; this is an accepted, disclosed latency window
(bounded by the reconciliation interval), not a new failure mode.

### 6. Launcher registry: multi-match lookup

`LauncherRegistry.findForModel()` today returns the first match via
`.find()`. The pool manager (#4.4) needs to enumerate *all* candidates and
filter by "not already claimed," so a new method is added —
`listForModel(modelId: string): LauncherInfo[]` — returning every active
launcher whose `servesModels` includes it, unfiltered by claim state (the
pool manager does that filtering itself, since only it has the pool state
to know what's claimed). `findForModel()` itself is left unchanged, since
`ensurePipelineReady()`'s cold-start fallback path still only needs one.

## Rejected Approaches

- **Cache-eviction-style preemption** (kill a low-demand pipeline anywhere
  to free its launcher for a higher-demand model). Rejected — see Goals
  above for the reasoning, resolved explicitly with the user.
- **Extending `PipelineTracker`'s existing single-slot shape with a
  separate "overflow" list** instead of a real `PooledPipeline[]`
  redesign. Rejected: this would create two different code paths for "the
  first pipeline" versus "every pipeline after the first," doubling the
  cases every consumer (`/generate`'s routing, the reconciliation loop's
  health check, scale-down) has to handle for no real benefit — a single
  array handles "one pipeline" as the `length === 1` case for free.
- **A global, cross-model launcher quota system with explicit priority
  tiers.** Considered and rejected as premature: this project has no real
  operator-facing story yet for "which models matter more," and the
  demand-sorted-claiming policy already resolved above provides a
  reasonable, simple default (available capacity goes to whatever's
  currently busiest) without needing a new configuration surface nobody
  has asked for yet.

## Open Questions

- **`swarm-launcher` has no explicit "stop"/"idle" verb.** Scale-down (#4.2)
  needs to actually terminate a pipeline's spawned agent, but the
  launcher's only endpoint is `POST /pipeline`, which spawns a *new* agent
  (killing the old one as a side effect of that, not as its own operation).
  There is no way to ask a launcher to "just stop, no replacement." This is
  a real gap the implementation plan needs to close — likely a new,
  minimal launcher endpoint (e.g. `POST /pipeline` with an empty/null
  `model` meaning "idle," or a dedicated `DELETE /pipeline`) rather than
  working around it coordinator-side. Left for the plan to resolve with a
  concrete, minimal C++ change, not decided here.
- **Exact values for the tunables** (30s reconciliation interval, 5-minute
  idle grace period, `REQUESTS_PER_PIPELINE = 10`) are starting points, not
  validated against real load — matching the original doc's own explicit
  instruction to ship something naive and revisit once this runs against
  real traffic. The plan should make these easy to change (constructor
  parameters or environment variables, consistent with this project's
  existing tunable patterns) rather than deeply hardcoded.

## Testing Considerations

- **The demand-to-pipeline-count scaling function** (#4.3) should be a
  pure, independently-testable function, same testing philosophy as
  `ReputationTracker`'s trust decision and `ModelCatalog`'s availability
  gating.
- **The allocation/claiming logic** (#4.4) should be tested as a pure
  function too where possible: given a set of models' current/desired
  counts, their demand figures, and a set of launchers with known claim
  state, does it produce the expected claim decisions? This is the piece
  most likely to have a subtle off-by-one or ordering bug (this project's
  own history — see `CLAUDE.md` — has repeatedly found exactly this class
  of bug via live probing, not unit tests alone, so a live multi-model,
  multi-launcher contention test belongs in this plan's whole-branch
  review too, not just a unit-level one).
- **The reconciliation loop's node-set-invalidation health check** (#4.1)
  needs a live test proving "a node is reputation-ejected or ages out
  mid-pipeline, and the pool self-heals before the next request" actually
  works end-to-end against a real coordinator/launcher/agent, not just in
  isolation — this is exactly the kind of previously-separate-subsystem
  interaction (reputation, pipeline pooling) this project's whole-branch
  reviews have repeatedly found real bugs in.
- **Round-robin selection under concurrent requests** needs a live check
  that it actually distributes load across multiple pool entries rather
  than degenerating to always picking the same one under race conditions
  (e.g. two `/generate` calls landing at nearly the same instant).
- **Needs real load-testing, not just correctness testing**, to validate
  the central claim motivating background pre-warming in the first place
  (does growing the swarm actually keep latency flat, or better, as
  intended) — unchanged from the original doc, still true, still not
  something a correctness-only test suite can establish.
