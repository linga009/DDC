# Security & Trust Hardening — Phase 3: Sybil-Resistant Reputation — Design

## Background: the four-phase initiative

This is Phase 3 of the Security & Trust Hardening initiative (see
`CLAUDE.md`'s Plan Roadmap). Phase 1 (shared-secret authentication,
`SWARM_AUTH_TOKEN`) and Phase 2 (real safety-classifier ruleset) are done
and merged. Phase 3 fixes `ReputationTracker`/`NodeRegistry`'s lack of
defense against churning registrations. Phase 4 (reputation-ranked node
selection for `POST /generate`) remains unstarted and undesigned, and
depends on this phase existing first — ranking by reputation is only
meaningful once reputation can't be freely reset.

The problem this phase closes is not newly discovered here — it is already
disclosed, in detail, and **verified live**, in README's "Known gaming
vectors" section (added when Phase A's request-routing work made it a
routing-hijack vector, not just a cosmetic one):

- `NodeRegistry.register()` mints a fresh `randomUUID()` on every call with
  no endpoint dedupe. An ejected node (5 disagreements, the default
  `minSamples`/`disagreementThreshold`) clears its record with one more
  `POST /nodes/register` call — verified live, immediate.
- Since `POST /generate` exists, this is no longer just a `/capacity`
  cosmetic count: an attacker who re-registers after ejection can become
  the sole remaining match for a model's `servesModel`, capturing real
  user traffic and, via the coordinator's authenticated outbound
  `/complete` call, the shared `SWARM_AUTH_TOKEN` itself — verified live.
- The same missing identity fix lets one physical endpoint register under
  several `localityGroup` values simultaneously — verified live: one
  endpoint, three concurrent registrations, three different groups, three
  distinct `nodeId`s, all live at once in `GET /nodes/locality`.

README already names the fix direction: *"Fixing the first requires stable
node identity (endpoint-keyed or node-supplied public key)."* This design
picks the endpoint-keyed option and works out its consequences.

## Goals

- A node's reputation history survives re-registration at the same
  endpoint — closing the "re-register to clear ejection" vector.
- A node's reputation history survives a full expire-and-re-register cycle
  (the 30-second heartbeat timeout pruning it from `NodeRegistry`, then
  registering again) — closing the "go quiet for 30 seconds, come back
  clean" vector, which a same-endpoint-dedupe-only fix (see Rejected
  Approach below) would **not** close.
- One physical endpoint can no longer occupy multiple `NodeRegistry`
  entries simultaneously — closing the multi-`localityGroup` vector as a
  side effect of the same mechanism, not a separate fix.
- Zero new dependencies (Node stdlib `crypto` only), and no change to
  `ReputationTracker`'s scoring logic — this phase is an identity fix, not
  a scoring-algorithm fix.

## Non-Goals

- **Decay/windowing of the disagreement ratio.** README's gaming-vectors
  section separately names that `ReputationTracker`'s all-time
  disagreement ratio has no decay, so an established node with a long good
  history needs an implausible run of *consecutive* disagreements to be
  ejected. This is a real, disclosed problem, but a different one — an
  established node going bad slowly, not a fresh/ejected node laundering
  its identity — and fixing it means changing `ReputationTracker`'s
  scoring function (a sliding window or EWMA), not `NodeRegistry`'s
  identity model. Deliberately deferred to a future phase, not folded in
  here, so this phase stays a single, surgical, low-risk change matching
  the project's established "narrow phase, name what's not solved"
  pattern (see Phase 2's design doc for the precedent).
- **Defense against many distinct fake identities.** This phase makes *a
  given endpoint's* identity stable and non-resettable. It does not stop
  an attacker who holds `SWARM_AUTH_TOKEN` from registering many
  *different* endpoints (e.g. several ports on one machine) as
  unrelated-looking nodes — each gets its own stable identity, but nothing
  here limits how many identities one attacker can mint. That remains an
  open problem; Phase 4's reputation-ranked selection and any future
  per-operator-credential work are the more plausible places to address
  it, not this phase.
- **Locality-group truthfulness.** `localityGroup` stays exactly as
  unverified and self-reported as before — this phase only stops one
  endpoint from claiming several groups *at the same time*. A node can
  still lie about which single group it's in.
- **Node-supplied public-key identity.** Considered and rejected for this
  phase — see Rejected Approaches below.
- **Persistence across coordinator restarts.** Every piece of state in
  this service is in-memory only, by disclosed design (see `CLAUDE.md`).
  This phase does not change that: identity is stable *within a
  coordinator process's lifetime*, not across a restart. A restart still
  wipes all reputation history for every node, same as today.

## Architecture

### `NodeRegistry.register()` (`coordinator/src/registry.ts`)

Changes from:

```typescript
register(endpoint: string, deviceTier: DeviceTier, localityGroup?: string, servesModel?: string): string {
  const nodeId = randomUUID();
  this.nodes.set(nodeId, { nodeId, endpoint, deviceTier, localityGroup, servesModel, lastSeen: this.clock() });
  return nodeId;
}
```

to deriving `nodeId` deterministically from the endpoint instead of
minting a random one:

```typescript
import { createHash } from "node:crypto";

function stableNodeId(endpoint: string): string {
  return createHash("sha256").update(endpoint.toLowerCase()).digest("hex");
}

register(endpoint: string, deviceTier: DeviceTier, localityGroup?: string, servesModel?: string): string {
  const nodeId = stableNodeId(endpoint);
  this.nodes.set(nodeId, { nodeId, endpoint, deviceTier, localityGroup, servesModel, lastSeen: this.clock() });
  return nodeId;
}
```

That's the entire mechanism. `this.nodes` is already a `Map<string,
StoredNode>` keyed by `nodeId` — once `nodeId` is a deterministic function
of `endpoint` rather than a random value, `Map.set` on a repeat
registration for the same endpoint **always overwrites the same key**,
regardless of whether the previous entry is still live, already expired,
or was already pruned out of the map entirely by `listActive()` or
`heartbeat()`. No separate "look up by endpoint" step, no auxiliary map,
no scan — this is why it closes the 30-second-quiet evasion where a
live-entries-only scan (the `PeerRegistry.register()` pattern — see
Rejected Approaches) would not: identity here doesn't depend on any state
surviving in `this.nodes` at all.

`server.ts`'s `/nodes/register` handler already normalizes `endpoint`
before calling `registry.register()` (`new URL(candidate.endpoint).href`
with the trailing slash stripped — see the existing
`normalizedNodeEndpoint` logic), so scheme and host are already
canonicalized by the time `NodeRegistry` sees the string. The
`.toLowerCase()` in `stableNodeId` is cheap extra insurance for any other
caller (tests call `register()` directly with bare strings like
`"127.0.0.1:50052"`, bypassing URL parsing entirely) and costs nothing,
but the real normalization contract lives at the HTTP boundary, same as
today.

**Re-registration semantics.** Because `Map.set` fully replaces the stored
value, a second `register()` call for the same endpoint refreshes
`lastSeen` *and* overwrites `deviceTier`/`localityGroup`/`servesModel` to
whatever the new call says — this is correct and desired (a node
legitimately restarting with a different `servesModel` should be able to
update its claim), and matches the existing refresh-in-place precedent in
`PeerRegistry.register()`. What's different from today: the identity
(`nodeId`) these fields are attached to no longer changes, so
`ReputationTracker`'s history for that identity carries forward
automatically.

### `ReputationTracker` (`coordinator/src/reputation_tracker.ts`)

**No changes.** It already keys `stats` by whatever `nodeId` string it's
given (`Map<string, NodeStats>`) and has no opinion on how that string is
derived. Once `nodeId` is stable per endpoint, `getOrCreate`/
`recordAgreement`/`recordDisagreement`/`isTrusted`/`getStats` all keep
working exactly as written, now against a persistent identity instead of a
throwaway one. This mirrors Phase 2's "the consuming class needs zero
changes" pattern with `KeywordSafetyClassifier`.

### `server.ts`, `client.ts`, dashboard, OpenAPI doc

Untouched. `nodeId` is already treated as an opaque string everywhere it's
used — in URL path segments (`/nodes/${nodeId}/heartbeat`,
`/nodes/${nodeId}/reputation/agree`), in `NodeInfo.nodeId: string`, in
`SwarmClient`. Nothing in this codebase parses or validates `nodeId` as a
UUID; a 64-character lowercase hex string is exactly as valid a path
segment and JSON string as a UUID was. Confirmed by reading every existing
`nodeId`-touching test in `coordinator/tests/`: none assert a UUID shape,
only `typeof nodeId === "string"`.

## Rejected Approaches

- **Live linear-scan dedupe, mirroring `PeerRegistry.register()`
  exactly.** `PeerRegistry` scans currently-active (non-expired) entries
  for a matching endpoint on every `register()` call and refreshes in
  place if found. This is simpler and stylistically consistent with
  existing code, but it only matches against entries that haven't yet
  aged out of the map — so it does **not** close the "go quiet for 30
  seconds, then re-register" evasion that README explicitly flags as a
  live concern (*"evicting on registry-prune alone is not attempted here,
  since it would open a new evasion path"*). `PeerRegistry` doesn't have
  this problem today because nothing reputation-sensitive is keyed by
  `peerId` yet — but that's exactly the gap `NodeRegistry` needs closed.
  Rejected because it only solves part of the problem this phase exists
  for.
- **Node-supplied public-key identity.** The strongest possible guarantee
  — an endpoint alone wouldn't be enough to steal or reset an identity,
  since the node would need to prove possession of a private key. Rejected
  for this phase because it's a materially bigger scope: key generation,
  a registration flow that carries a public key and a proof of possession,
  and — implicitly — a story for key rotation and loss, none of which
  exist anywhere in this codebase today. Phase 1's design doc already
  explicitly deferred "per-node individual tokens, issuance, or
  revocation" as future scope beyond the one-shared-secret v1 model; a
  node keypair is the same category of larger project, not this phase's
  job.
- **A separate, persistent `endpoint → nodeId` lookup table**, keeping
  `nodeId` random but adding a second map that outlives individual node
  entries. Rejected as strictly more complex than deriving `nodeId`
  directly from `endpoint` for the identical result: it would need its own
  independent pruning story (or grow unboundedly), while a hash function
  needs none — it has no state to prune in the first place.

## Open Questions

- **`nodeId` predictability.** Deriving `nodeId` from `endpoint` means
  anyone who knows (or guesses) a node's endpoint can compute its
  `nodeId` without ever calling the coordinator. In practice this isn't a
  new exposure: `GET /nodes` already returns every active node's
  `endpoint` and `nodeId` together to any token holder, and `nodeId` alone
  grants no capability without also holding `SWARM_AUTH_TOKEN` (every
  reputation-mutating endpoint requires it, per Phase 1). Named here in
  case a future phase changes that assumption.
- **Hash truncation.** This design uses the full 64-character sha256 hex
  digest. It could be truncated for a shorter identifier at a
  (astronomically) small increased collision risk. Not truncating is the
  simpler default and this doc doesn't see a reason to spend the
  complexity, but it's a one-line choice a plan author could revisit.

## Testing Considerations

- `registry.test.ts`: registering the same endpoint twice returns the same
  `nodeId` both times and does not increase `size()`; registering the same
  endpoint with different `deviceTier`/`localityGroup`/`servesModel`
  across calls updates those fields in place under the same `nodeId`
  (only the latest claim is visible via `listActive()`); two different
  endpoints still produce two different `nodeId`s (the existing "multiple
  nodes are tracked independently" test's `notEqual` assertion must keep
  passing); a regression test reproducing the README's exact multi-group
  scenario — the same endpoint registered under three different
  `localityGroup` values in sequence results in exactly one active node
  at a time, in the most recently claimed group, never three
  simultaneously.
- A new cross-class test (`registry.test.ts` or a combined
  registry+reputation test): advance a fake clock past the heartbeat
  timeout so the node is pruned from `NodeRegistry`, then register the
  same endpoint again — confirm the returned `nodeId` is identical to the
  original, and that `ReputationTracker.isTrusted`/`getStats` for it still
  reflect the pre-expiry history (i.e. an ejected node that goes quiet and
  comes back is still ejected, not reset).
- `server.test.ts`: no behavioral changes expected at the HTTP layer
  beyond `nodeId`'s value no longer being a UUID — existing
  `typeof nodeId === "string"` assertions keep passing unmodified.
- A live check belongs in this phase's whole-branch review, matching this
  project's established live-probing practice for coordinator/HTTP-surface
  work — direct reproduction of the exact scenario README documents as
  "verified live": register a node, record 5 disagreements against a real
  running coordinator to eject it, confirm `GET /nodes` excludes it,
  re-register the same endpoint, and confirm it is **still** excluded
  (rather than reappearing with a clean slate as it does on `master`
  today).
