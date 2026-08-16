# Phase C: Background Pre-Warming & Demand-Based Autoscaling — Design

> Forward-looking design, written before any implementation and before
> Phase B exists. This spec assumes Phase B's launcher/assembly mechanism
> is built — Phase C is entirely about *when* and *how many* pipelines get
> assembled, not *how*. If Phase B's design changes materially during
> implementation, revisit this doc before building against it.

## Summary

Phase B (design only, not yet built) makes pipeline assembly *possible* —
the coordinator can decide on and cause a pipeline to exist. But Phase B on
its own only reacts: it assembles a pipeline the first time a request
needs one that doesn't exist, paying the full model-load latency inline,
and it assumes one pipeline per model is enough. Phase C removes both
limitations: pipelines for popular models get assembled *before* anyone
asks (closing the gap this project has disclosed since Plan 8 — `/catalog`
saying a model is "available" based on raw node count, when no warm
pipeline may actually exist for it), and the number of concurrent warm
pipelines per model grows or shrinks with observed demand.

This is also where the project's stated differentiator gets tested for
real: the whole pitch for choosing background pre-assembly over
synchronous per-request assembly (decided early, before Phase A was built)
was that it's the only approach where growing the swarm — more nodes, more
users — doesn't make latency worse. Phase C is where that has to actually
hold up under something resembling real load, not just reasoning.

## Goals

- Reconcile `/catalog`'s `available` flag with reality: a model should show
  `available: true` only when a warm, request-ready pipeline actually
  exists for it (or can be assembled fast enough not to matter), not
  merely when enough raw node count is registered.
- Track demand per model (recent/concurrent request volume) and use it to
  decide how many warm pipelines to keep for that model, within whatever
  capacity is currently available.
- Handle pipeline churn — a node in a warm pipeline gets reputation-ejected
  or ages out of the registry — by triggering reassembly proactively,
  before the next request discovers the pipeline is broken.

## Non-Goals

- **Deciding which specific nodes go into a pipeline** — that's Phase B's
  scoring problem, reused unchanged here.
- **Token streaming** — Phase D, unrelated axis.
- **Cross-instance (federated) autoscaling** — this repo's federation layer
  (Plan 6) shares capacity *counts* between coordinator instances; Phase C
  as scoped here only manages this instance's own pipeline pool. Extending
  autoscaling decisions across federated instances is a materially harder
  problem (whose pipeline serves a given request when multiple instances
  could) and explicitly out of scope.
- **A general job-scheduling system.** Phase C is specifically about LLM
  inference pipelines, not a reusable abstraction for scheduling arbitrary
  work across the swarm.

## Architecture

A new coordinator-side component — a **pipeline pool manager** — running as
a periodic background loop (not per-request), responsible for:

```
every N seconds (a tunable reconciliation interval):
  for each catalog model:
    desired = decide_desired_pipeline_count(model, recent_demand[model], available_capacity)
    current = count_warm_pipelines(model)
    if current < desired:
      assemble additional pipelines via Phase B's launcher mechanism
    if current > desired and a pipeline has been idle past a grace period:
      tear it down (releasing its nodes back to the available pool)
    for each existing pipeline of this model:
      if any of its nodes are no longer active/trusted (registry/reputation check):
        trigger reassembly for that pipeline specifically
```

`/generate`'s node-selection step changes from Phase A's "any active node
with matching `servesModel`" to "pick a warm pipeline from this model's
pool" (round-robin or least-recently-used across the pool, to spread load
rather than hammering one pipeline).

## The Demand Signal

`recent_demand[model]` needs a concrete definition — proposed: a sliding
window (e.g., request count over the last 60 seconds) per `modelId`,
tracked wherever `/generate` already knows the requested model. This is a
small, in-memory counter, consistent with every other piece of state in
this coordinator (in-memory only, not persisted, disclosed limitation
matching `NodeRegistry`/`ReputationTracker`/`PeerRegistry`'s existing
posture).

**Open question:** what's the actual scaling function from demand to
desired pipeline count? A naive "one more pipeline per N requests/minute"
is a starting point, but real tuning requires knowing real request
latency and real pipeline throughput — data this project doesn't have yet,
since nothing has been load-tested. Ship a simple, clearly-labeled-as-naive
function first (e.g., a fixed ratio with a hard cap), instrument it, and
revisit once Phase C has run against real traffic. Do not over-engineer
the scaling algorithm before there's real demand data to tune it against.

## Interaction with Reputation and Locality

- A pipeline pool should prefer building new pipelines from
  higher-reputation, same-locality-group node combinations first — reusing
  Phase B's scoring, just triggered proactively instead of reactively.
- If reputation ejection removes a node mid-pipeline (a live request could
  be in flight through it — this exact scenario was verified live during
  Plan 13's whole-branch review: an in-flight request completes normally
  even after its node is ejected mid-flight, since selection already
  happened), Phase C's reconciliation loop should notice the pipeline's
  node set is now invalid and trigger reassembly *before* the next
  request tries to use it — turning what was previously a per-request
  `503`/`502` risk into a background-healed condition most callers never
  see.

## Known Limitations to Disclose From Day One (matching this project's convention)

- Pool state is in-memory only — a coordinator restart forgets which
  pipelines were warm and has to rebuild its pool from scratch, same
  posture as every other piece of state here.
- The reconciliation interval creates a window where `/catalog` can lag
  reality (a model just became genuinely available, or just lost its last
  pipeline, and the loop hasn't run yet) — bound this explicitly with a
  short, documented interval rather than leaving it vague.
- No cross-instance coordination on autoscaling decisions (see Non-Goals)
  — two federated instances could each independently try to build
  pipelines from overlapping capacity if a node is somehow visible to
  both, though this project's federation model (Plan 6) already doesn't
  give one instance authority over another's registered nodes, so this is
  more a latent inefficiency than a correctness bug.

## Testing Considerations

- The demand-to-pipeline-count scaling function should be a pure,
  independently-testable function (given a demand history and available
  capacity, what's the desired count) — same testing philosophy as
  `ReputationTracker`'s trust decision (Plan 8) and `ModelCatalog`'s
  availability gating.
- The reconciliation loop's node-set-invalidation check needs a live test
  proving the "ejected mid-pipeline, healed before next request" scenario
  actually works end-to-end, not just in isolation — this is exactly the
  kind of interaction between two previously-separate subsystems
  (reputation, pipeline pooling) that this project's whole-branch reviews
  have repeatedly found real bugs in when only unit-tested.
- Needs real load-testing, not just correctness testing, to validate the
  central claim motivating background pre-warming in the first place
  (does growing the swarm actually keep latency flat, or better, as
  intended) — this is the first phase where that claim can actually be
  measured rather than argued.
