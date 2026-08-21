# Security & Trust Hardening — Phase 4: Reputation-Ranked Node Selection — Design

## Background: the four-phase initiative

This is Phase 4, the last phase of the Security & Trust Hardening initiative
(see `CLAUDE.md`'s Plan Roadmap). Phase 1 (shared-secret authentication,
`SWARM_AUTH_TOKEN`) is done and merged. Phase 2 (real safety-classifier
ruleset) has substantial implementation committed on its own unmerged
branch (`security-phase-2-classifier-ruleset`), not yet whole-branch-
reviewed or merged. Phase 3 (sybil-resistant reputation — `nodeId` derived
deterministically from endpoint instead of randomly) is done and merged.
Phase 4 does not depend on Phase 2's completion; it does depend on Phase 3,
which is why it comes last — ranking by reputation is only worth doing
once an identity can't be trivially reset by re-registering (though, per
Phase 3's whole-branch review, only *reset by re-registering the identical
endpoint string* — see Non-Goals below).

Today, `POST /generate` (`coordinator/src/server.ts`) selects a node with:

```typescript
const node = registry.listActive(reputation).find(n => n.servesModel === candidate.modelId);
```

This is first-match: `Array.prototype.find` returns the first candidate in
`Map` insertion order that both passes `NodeRegistry.listActive`'s
reputation filter (`ReputationTracker.isTrusted`) and claims the requested
`servesModel`. Two trusted nodes serving the same model are not
distinguished at all — whichever registered first (or most recently
overwrote the registry entry) always wins, forever, regardless of how much
better one node's track record is than the other's.

This is narrower than Phase B (`docs/superpowers/specs/2026-08-16-phase-b-dynamic-pipeline-assembly-design.md`,
design written, not implemented): Phase B is about assembling a *multi-node
pipeline* live from the registry; this phase only ranks among
already-registered *single* nodes for one `/generate` call. It does not
build toward pipeline assembly and does not need to.

## Goals

- `POST /generate` picks the best-scoring trusted, `servesModel`-matching
  node instead of the first one found.
- Zero behavioral change for the common case today: 0 or 1 eligible
  candidate. (This walking skeleton typically has exactly one node per
  model in any given manual test setup.)
- Deterministic, unit-testable ranking logic, isolated from HTTP handling.
- Ties (most commonly: multiple untested nodes, all scoring the same
  neutral value) are broken by picking uniformly at random among the tied
  set, so equally-trusted nodes share load instead of one perpetually
  winning by registration order.
- Zero change to `ReputationTracker`'s existing eligibility semantics —
  `isTrusted()`, `minSamples`, `disagreementThreshold` are untouched. This
  phase adds a *ranking* signal on top of the existing *eligibility* gate;
  it does not redefine who is eligible.

## Non-Goals

- **No automatic reputation feedback from `/generate`'s own outcomes.**
  Nothing in this codebase today automatically calls
  `reputation.recordAgreement`/`recordDisagreement` based on a `/generate`
  call's success or failure — confirmed by reading `server.ts`'s
  `/generate` handler (it forwards and returns, no reputation side effect)
  and `coordinator/public/app.js` (the dashboard never calls the
  reputation endpoints either). `POST /nodes/:nodeId/reputation/agree` and
  `.../disagree` exist only as externally/manually-driven API surface.
  This phase ranks on whatever reputation data already exists by whatever
  means it got there; it does not create a source of that data. Explicitly
  discussed and deferred: an automatic feedback loop is real future work
  (matching README's already-named "future spot-check-mechanism plan")
  but is a separate policy decision (what counts as a disagreement — a
  502? a timeout? a node returning text we have no way to verify?) that
  would roughly double this phase's scope.
- **No change to `isTrusted()`'s eligibility gate.** A node must already
  pass the existing `minSamples`/`disagreementThreshold` check to be a
  ranking candidate at all. This phase only orders survivors of that gate;
  it does not change who survives it.
- **No general load-balancing.** The random tie-break spreads load only
  among nodes that are *exactly* tied on score. There is no in-flight-
  request tracking, no weighting by node capacity/`deviceTier`, no
  awareness of concurrent load — this is a ranking mechanism, not a
  scheduler.
- **No locality-awareness.** Ranking is reputation-only; `GET
  /nodes/locality` remains an independent, unconsumed interface (per
  README, no locality-aware routing exists anywhere yet).
- **Does not address the endpoint-aliasing gap Phase 3 disclosed.** A
  `nodeId`'s score is only as trustworthy as the identity it's attached
  to. Phase 3's whole-branch review found that `stableNodeId()` only
  lowercases the endpoint, it does not canonicalize host aliases — so an
  operator can still mint a fresh, neutral-scoring (0.5, see Architecture)
  identity for the same physical node by re-registering under an alias
  (`127.0.0.1` vs `localhost` vs `[::1]` vs a trailing-dot FQDN vs any
  other DNS name pointed at the same machine). "Reputation-ranked" is only
  as meaningful as the identity stability Phase 3 actually provides, which
  is per *endpoint string*, not per *physical node*. This phase doesn't
  attempt to close that gap — see Phase 3's design doc's Rejected
  Approaches for why (node-supplied public-key identity is the real fix
  and is a materially bigger scope).
- **No exposure of the score via a new or existing endpoint.** `GET
  /nodes/:nodeId/reputation` keeps returning exactly
  `{agreements, disagreements, trusted}`; the new `score()` method is
  consumed internally by `/generate`'s selection step only. (Named as an
  Open Question below — a natural, low-cost follow-on, not required here.)

## Architecture

### `ReputationTracker.score()` (`coordinator/src/reputation_tracker.ts`)

One new public method, no changes to any existing method:

```typescript
score(nodeId: string): number {
  const { agreements, disagreements } = this.getStats(nodeId);
  return (agreements + 1) / (agreements + disagreements + 2);
}
```

Laplace/"rule of succession" smoothing. Properties that matter here:

- **A node with no recorded history (`0/0`) scores exactly `0.5`** — a
  known, fixed neutral value, not a special case the caller has to branch
  on. `getStats()` already returns `{agreements: 0, disagreements: 0}` for
  an unknown `nodeId` (see its existing implementation), so `score()`
  needs no additional handling for "never recorded" nodes at all.
- **More evidence at the same ratio scores closer to the extreme.** A node
  with 100 agreements and 0 disagreements scores `≈0.9902`; one with 2
  agreements and 0 disagreements scores `0.75` — both have a "perfect"
  1.0 raw ratio, but the formula still ranks the longer track record
  higher. This is exactly what "reputation-ranked" should mean, and makes
  it harder to game the top rank by registering many fresh low-sample
  nodes (a fresh node scores `0.5`, strictly below any node with a
  genuinely more-agreements-than-disagreements history).
- **Any node whose `agreements === disagreements` scores exactly `0.5`,
  tying with every untested node.** `1/1` → `2/4 = 0.5`; `10/10` → `11/22
  = 0.5`. This is intentional, not a bug: a node with as much disagreement
  as agreement evidence really is exactly as (un)trustworthy, by this
  formula, as one with no evidence at all — but it means the "tied at the
  top" set in practice is usually larger than just the never-recorded
  nodes, and testing should cover this case explicitly (see Testing
  Considerations).

No changes to `isTrusted()`, `getStats()`, `recordAgreement()`,
`recordDisagreement()`, or the constructor.

### `selectNode()` and `createServer()`'s new `random` parameter (`coordinator/src/server.ts`)

A new module-level pure function, alongside this file's existing top-level
helpers (`isAuthorized`, `fetchPeerCapacity`, `withTimeout`):

```typescript
function selectNode(nodes: NodeInfo[], reputation: ReputationTracker, modelId: string, random: () => number): NodeInfo | undefined {
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
  // Unique max: never calls random() at all -- a test can inject a
  // random() that throws to assert no tie-break was needed.
  return best.length === 1 ? best[0] : best[Math.floor(random() * best.length)];
}
```

`/generate`'s handler changes from:

```typescript
const node = registry.listActive(reputation).find(n => n.servesModel === candidate.modelId);
```

to:

```typescript
const node = selectNode(registry.listActive(reputation), reputation, candidate.modelId, random);
```

`registry.listActive(reputation)` already does the active+trusted
filtering exactly as today (unchanged call); `selectNode` adds the
`servesModel` filter and the scoring/tie-break on top, exactly mirroring
what `.find()` used to do plus ranking.

`createServer(registry, catalog, peers, classifier, reputation, authToken)`
gains one new optional parameter:
`random: () => number = Math.random`, appended at the end (keeping every
existing call site source-compatible without a default-value change to
existing parameters), consumed only by the `/generate` route's call to
`selectNode`. This mirrors `NodeRegistry`'s existing
`constructor(clock: () => number = Date.now, timeoutMs = 30000)` pattern
for injectable non-determinism — `coordinator/tests/server.test.ts`'s
`startTestServer()` helper will need a passthrough for it, the same way it
already threads through a fake `registry`/`catalog`/`peers`/`classifier`.

### What does not change

`NodeRegistry`, `ReputationTracker`'s existing methods, every other route
handler, `client.ts`, `openapi.ts`, the dashboard — none of these need to
change. `GET /nodes/:nodeId/reputation`'s response shape is unchanged.

## Rejected Approaches

- **Raw disagreement ratio** (`disagreements / total`, ascending, treating
  untested nodes as ratio `0`). Simpler formula, but a brand-new,
  zero-evidence node would rank *above* an established node with even a
  single disagreement out of hundreds of agreements — cheap to game by
  registering fresh nodes to sit at the top. Rejected in favor of
  Laplace smoothing, which naturally resists this (see Architecture).
- **Tiered ranking** (bucket into "proven-good" vs. "everyone else" using
  `minSamples` as the bucket boundary, always prefer the first bucket).
  More moving parts, and silently couples ranking behavior to
  `ReputationTracker`'s `minSamples` constructor parameter — reconfiguring
  that threshold for eligibility purposes would also reshape ranking
  behavior as an unintended side effect. Rejected for the single-formula
  approach, which has no such coupling.
- **Deterministic (registration-order) tie-break instead of random.**
  Simpler, no RNG injection surface needed, and was the initial
  recommendation — but concentrates all load from a tied group onto
  whichever node happened to register first, forever. Rejected: a
  swarm's whole point is spreading load across pooled volunteer devices;
  always picking the same one among equally-trusted candidates works
  against that.
- **Automatic reputation feedback from `/generate`'s own outcomes as part
  of this phase.** Would give ranking real data to work with immediately
  instead of ranking mostly-untested (`0.5`) nodes in most present-day
  usage, but requires a separate policy decision about what constitutes
  agreement/disagreement from an HTTP-level outcome alone (a 502 is
  probably a disagreement; is a 200 with slow/truncated/garbled text an
  agreement just because it returned successfully? this codebase has no
  way to verify output quality). Rejected for this phase, matching the
  project's narrow-phase pattern; named as real future work above.

## Open Questions

- **Should `score()` be exposed via `GET /nodes/:nodeId/reputation`?**
  Not required for this phase's stated scope (`/generate`'s internal
  selection only), but it's a one-line addition to that endpoint's
  response object if a future consumer (the dashboard, an operator
  debugging why a node isn't getting picked) wants to see it. Left out
  here to keep this phase's surface area minimal; a natural, low-risk
  follow-on if requested.
- **Floating-point tie detection.** `selectNode`'s `s === bestScore` check
  relies on IEEE 754 double equality. Since `score()` is a pure function
  of two non-negative integers via simple division, two nodes with
  identical `(agreements, disagreements)` pairs are guaranteed to produce
  bit-identical results (same inputs, same deterministic arithmetic) —
  and, as noted in Architecture, different pairs can also coincide exactly
  (any `agreements === disagreements` pair produces exactly `0.5`). No
  epsilon-based comparison is needed; exact equality is the *correct*
  check here, not an approximation. Named only so a future reader doesn't
  "fix" this into an epsilon comparison by reflex.

## Testing Considerations

- `reputation_tracker.test.ts`: `score()` unit tests — `0/0` → `0.5`
  exactly; a node with only agreements approaches `1` as the count grows;
  a node with only disagreements approaches `0`; equal agreements and
  disagreements (e.g. `3` agreements / `3` disagreements) → `0.5`, same as
  `0/0`; more evidence at an equal raw ratio scores further from the
  extreme (e.g. 100 agreements/0 disagreements scores higher than 2
  agreements/0 disagreements, expressed as a strict inequality, not an
  exact value, so the test doesn't hardcode the formula's constants).
- `server.test.ts`: `selectNode` should be exported (or tested indirectly
  through `/generate` — implementer's call, but direct unit tests of the
  pure function are cheaper to write and reason about than HTTP-level
  ones for pure ranking-logic edge cases): empty candidate list →
  `undefined`; single candidate → returned without calling `random()`
  (assert via a `random` that throws if invoked, catching an accidental
  call on the non-tied path); two candidates with distinct scores →
  higher-scoring one always returned, `random()` never invoked; two or
  three candidates tied at `0.5` with an injected deterministic `random`
  (e.g. `() => 0`, `() => 0.999`) → confirms the exact expected index is
  chosen, covering both ends of the tied set.
- HTTP-level `/generate` test: two nodes registered for the same
  `servesModel`, one given a strong agreement history via
  `POST /nodes/:nodeId/reputation/agree` calls, the other left untested —
  confirm `/generate` always routes to the node with the stronger record
  (repeat several times if using real `Math.random` to rule out flakiness,
  or inject `random` via `startTestServer`'s new passthrough for a fully
  deterministic assertion).
- Regression: every existing `/generate` test with exactly one matching
  node must keep passing unmodified — `selectNode` with one candidate is
  behaviorally identical to the old `.find()`.
- A live check belongs in the whole-branch review, matching this
  project's established practice: register two nodes serving the same
  model, give one a clean track record and the other a poor one via real
  `POST /nodes/:nodeId/reputation/agree|disagree` calls against a running
  coordinator, and confirm `POST /generate` consistently routes to the
  better-reputed node rather than whichever registered first.
