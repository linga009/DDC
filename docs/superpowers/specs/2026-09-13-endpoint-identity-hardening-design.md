# Endpoint Identity Hardening — Implementation Design

**Status:** design only, nothing implemented.
**Date:** 2026-09-13
**Supersedes:** nothing. Closes a gap disclosed since Security Hardening
Phase 3 and re-surfaced by Phase C's whole-branch reviews.

## The problem

An endpoint **string** is not a machine identity, anywhere in this service.

1. **`NodeRegistry`** derives `nodeId` as `sha256(endpoint.toLowerCase())`
   (`coordinator/src/registry.ts`). Lowercasing is not canonicalization, so
   one listening socket answers to unlimited alias strings for free:
   `http://127.0.0.1:P`, `http://localhost:P`, `http://[::1]:P`, a
   trailing-dot FQDN, or any DNS name pointed at the same machine each get
   a separate, clean identity. Live-verified in Phase 3: an ejected node
   re-registers under an alias and comes back `0/0, trusted: true`.
2. **`LauncherRegistry` + `claimedLauncherIds()`** tally a launcher as busy
   by `launcherId` *and* `launcherEndpoint` string (Phase C). One physical
   launcher registered under two aliases therefore looks like two idle
   machines and can be claimed twice — and since a `swarm-launcher`
   supervises exactly one agent at a time, the second claim silently
   repoints the first model's pipeline. Live-verified in Phase C's third
   review: **a caller asking for model A received model B's weights with a
   `200`.**
3. **Overwrite/griefing.** Because `register()` overwrites by `nodeId`, any
   token-holder who knows a node's exact endpoint (readable from
   `GET /nodes`) can strip that node's `servesModel`/`deviceTier`/
   `localityGroup` in one call, with zero reputation trace. Disclosed in
   Phase 3, still live.

These are **two different kinds of problem** and the design treats them as
such:

- (2) is a **correctness** bug that hits *honest* operators. One machine,
  two names, corrupted routing. Nobody has to attack anything.
- (1) and (3) are **security** gaps, and it is important to be precise
  about how much closing aliasing actually buys: an attacker who holds
  `SWARM_AUTH_TOKEN` can already mint unlimited genuinely-distinct
  identities by registering different ports on one machine. Canonicalizing
  aliases makes reputation-resetting *cost something* rather than being
  free and instant; it does not make it impossible. Anyone reading this
  design should not mistake it for Sybil resistance.

## Goals

- One physical listening socket resolves to **one** identity, regardless of
  which alias string was used to register it.
- Registering an endpoint you do not control cannot overwrite, strip, or
  falsify what that endpoint reports about itself.
- No new C++ dependency, and no change to this project's zero-npm-dependency
  coordinator constraint.

## Non-goals

- **Sybil resistance.** Distinct endpoints are still distinct identities; a
  token-holder can still register many. Unchanged from today.
- **Public-key identity.** The mechanism this repo's README has gestured at
  since Phase 3 (`nodeId = hash(pubkey)`) would make identity independent of
  the endpoint entirely. It is rejected here for a concrete reason, not a
  vague one: **there is no crypto library anywhere in `core/`** — the C++
  targets link only `llama`, `ggml`, and `ws2_32` — so signing in
  `swarm-node-agent`/`swarm-launcher` would mean either adding OpenSSL
  (against this project's deliberate dependency-light, raw-C-API-only
  stance) or hand-rolling Ed25519, which is worse. Revisit only as an
  explicit dependency decision.
- **TLS / encryption in transit.** Out of scope, as in every prior phase.
- **Per-node or per-operator credentials.** Still one swarm-wide
  `SWARM_AUTH_TOKEN`.

## Mechanism 1 — Endpoint canonicalization

Identity becomes a **canonical host + port**, not the raw string.

Canonicalization steps, applied at registration time:

1. Parse with `new URL()` (already done today) and lowercase the host
   (already done today via `.href`).
2. Strip a trailing dot from the hostname (`example.com.` → `example.com`).
3. Resolve the hostname to an IP via `node:dns`'s `promises.lookup`
   (`node:` builtin — no dependency added).
4. Collapse every loopback form to one token: `127.0.0.0/8`, `::1`, and
   `localhost` all canonicalize to the same value. This is the single most
   common real-world alias set and the one that produced Phase C's
   wrong-model bug.
5. Resolve the port explicitly (a scheme default when absent: 80/443).
6. Identity key = `canonicalHost:port`. **Scheme is deliberately excluded**
   — `http://h:P` and `https://h:P` are the same listening machine for
   identity purposes.

**The contact URL and the identity key are stored separately.** The
coordinator must keep fetching the exact URL the operator registered
(`${node.endpoint}/complete`), because an IP substitution would break TLS
SNI and name-based virtual hosting. Only the *identity* is canonical.

### The attack canonicalization introduces, and why Mechanism 2 is not optional

DNS-derived identity is attacker-influenced: point a DNS name you control at
**someone else's IP**, register it, and you collide with their identity —
turning canonicalization into a *better* griefing primitive than the one in
problem (3). Mechanism 2 is what makes this safe, which is why this design
ships them together and why neither half should be implemented alone.

## Mechanism 2 — Endpoint-authoritative registration

Today `POST /nodes/register` believes whatever the caller says about a
machine. The fix is to **ask the machine**.

On registration the coordinator:

1. Generates a single-use nonce (`node:crypto` `randomUUID`).
2. Calls `POST /identity` on the claimed endpoint with `{nonce}`, bearing
   the usual `Authorization: Bearer` header and an `AbortSignal.timeout`.
3. Expects `{nonce, deviceTier, servesModel?, localityGroup?,
   availableMemoryMb?}` back. The nonce must match exactly.
4. **Stores the fields the endpoint reported, not the ones the caller
   supplied.** Caller-supplied values are accepted in the request body for
   backward compatibility but are overridden by the endpoint's own answer.

Why this closes overwrite without needing the agent to call the coordinator:
re-registering a competitor's endpoint now simply asks that competitor's own
agent what it serves, and it answers truthfully. The registration becomes a
**no-op refresh of the victim's true state** instead of a strip. The same
mechanic defeats the DNS-collision attack above: the callback lands on the
real owner, who reports their own fields.

This also upgrades `servesModel`/`deviceTier` from "asserted by whoever
called register" to "asserted by whoever started the agent, reported by the
agent" — a real, if partial, improvement to a caveat this README has carried
since Plan 3. It is **not** full verification: the agent still asserts these
about itself and nothing measures them; it only removes *third parties* from
the trust path. See the C++ section below for the per-field split, including
the two fields this phase cannot improve.

### Why not a two-step challenge

The obvious alternative — coordinator returns a nonce, the registrant must
prove it received that nonce at its endpoint — requires the agent to
**initiate** an outbound call to the coordinator. Neither
`swarm-node-agent` nor `swarm-launcher` self-registers today: there is no
`--coordinator` flag and no outbound HTTP client in either binary
(verified, `core/src/node_agent_main.cpp`, `core/src/launcher_main.cpp`).
Adding one is a larger change than this phase needs, and the
endpoint-authoritative construction achieves the same guarantee with only a
new **inbound** route, which is exactly the shape both binaries already
have.

## Architecture

### `coordinator/src/endpoint_identity.ts` (new)

Pure, independently testable — the project's established shape for decision
logic (`pipeline_selector.ts`, `desiredPipelineCount`).

- `canonicalizeEndpoint(endpoint: string, resolve: Resolver): Promise<string>`
  — returns the `canonicalHost:port` identity key. `resolve` is injected
  (mirroring `NodeRegistry`'s injectable `clock`) so tests never touch real
  DNS.
- `isLoopback(address: string): boolean`.
- DNS failure is **not** fatal: fall back to the lowercased, trailing-dot-
  stripped hostname. A node on a name the coordinator cannot resolve must
  still be registerable — it just keeps today's weaker identity. This is a
  deliberate availability-over-strictness call and must be disclosed.

### `coordinator/src/registry.ts`

- `stableNodeId()` takes the **canonical identity key** rather than the raw
  endpoint. Signature changes from `(endpoint)` to `(identityKey)`; the
  callers do the canonicalization.
- `NodeInfo` keeps `endpoint` as the contact URL, unchanged.

### `coordinator/src/launcher_registry.ts` + `pipeline_pool_manager.ts`

- `LauncherInfo` gains a canonical identity key; `register()` matches on it
  instead of raw endpoint equality.
- `claimedLauncherIds()` / `isLauncherClaimed()` tally the canonical key.
  **Both call sites must move together** — Phase C's three review rounds
  were all caused by a rule applied asymmetrically, and this is the same
  shape of change.

### `coordinator/src/server.ts`

- All three register routes (`/nodes/register`, `/launchers/register`, and
  `/peers/register`) canonicalize before deriving identity.
- `/nodes/register` and `/launchers/register` perform the `/identity`
  callback. **`/peers/register` does not** — a peer is another coordinator,
  which has no agent `/identity` route; peers keep today's behavior and
  this asymmetry must be stated in the README, not left implicit.
- Phase B/C's launcher-spawned drivers are registered *by the coordinator
  itself* (`registry.register(driverEndpoint, ...)` inside
  `assemblePipeline`/`tryAssemble`). These must **skip** the callback — the
  coordinator just spawned the agent and a freshly-started agent may not be
  listening yet. This is an internal, trusted path.

### C++ — `core/src/node_agent_main.cpp`, `core/src/launcher_main.cpp`

A new `POST /identity` route on each, registered via the existing
`server.route("POST", "/identity", ...)` exact-(method, path) API, building
its response with the existing `jsonEscapeString()` helper.

**Grounded correction to the section above.** An earlier draft of this
design assumed each binary already knows what it serves. It does not:

- `swarm-node-agent` stores a `--model` *file path*
  (`core/src/node_agent_main.cpp`), not a catalog `modelId` like
  `tinyllama-1.1b`. It therefore cannot report `servesModel` today.
- `swarm-launcher` has **no** `--serves-models` flag at all — its flags are
  `--port`, `--agent-port`, `--models-dir`, `--node-agent-path`. It can
  spawn any model present in `--models-dir`, so "which models does this
  launcher serve" is genuinely not a fact it possesses.

So the phase must also add:

- `--serves-model <id>` to `swarm-node-agent`, the catalog id it is serving.
  `swarm-launcher` already receives that id in `POST /pipeline`'s `model`
  field and passes it through when spawning, so the loop closes with no new
  operator burden for launcher-spawned drivers.
- `--device-tier <tier>` to `swarm-node-agent`, defaulting to `desktop`
  (the value Phase B already hardcodes for spawned drivers).

This materially changes what the callback can assert, and the design is
honest about the split rather than over-claiming:

| Field | After this phase |
|---|---|
| `servesModel` | Declared by whoever **starts** the agent, reported by the agent. A third party registering that endpoint can no longer forge or strip it. |
| `deviceTier` | Same. |
| `localityGroup` | **Still caller-supplied and unverified** — the agent has no notion of it. |
| `availableMemoryMb` | **Still caller-supplied and unverified**, and still unmeasured. |

For the **launcher**, the callback can authoritatively confirm only liveness
and `agentPort` (which matters: Phase C derives a prospective driver's
identity from `launcherHost:agentPort`). `servesModels` stays caller-supplied
and must remain disclosed as unverified — the launcher cannot know it.

The agent's route is **auth-gated** like `/health` and `/complete`. The
launcher's is **not**, matching its existing deliberate no-auth,
`127.0.0.1`-bind-only posture — adding auth to one launcher route would be
inconsistent with `POST /pipeline`/`DELETE /pipeline`.

## What this does and does not close

**Closes:** the launcher double-claim and its wrong-model-served
consequence; free reputation reset by loopback/DNS aliasing; the
`servesModel`-strip griefing primitive; and the DNS-collision attack that
canonicalization alone would have introduced.

**Does not close:** Sybil identity minting via genuinely distinct
endpoints/ports (explicit non-goal); aliasing where DNS resolution fails
and the fallback applies; a *malicious agent* lying about its own
`deviceTier`/`availableMemoryMb` in its `/identity` answer; and the
reputation-rehab-in-place path (6 `agree` calls), which is unrelated to
identity and stays open.

## Known risks

- **Registration now performs network I/O.** It becomes slower and can fail
  for reasons unrelated to the caller. Needs a timeout and a clear error
  distinguishing "your endpoint did not answer" from "your request was
  malformed."
- **Breaking protocol change.** An older `swarm-node-agent` without
  `/identity` cannot register against a new coordinator. This is a genuine
  compatibility break and must be called out in README rather than
  discovered. Whether to add a grace mode (accept registration when
  `/identity` 404s, flagged unverified) is the main open question below.
- **DNS at registration time** can differ from DNS at request time.
  Identity is pinned at registration; the contact URL is not.
- This touches `NodeRegistry` identity, which `ReputationTracker` keys on.
  Existing reputation records survive only for nodes whose canonical key
  equals their old key — for anything registered under an alias, history
  resets once. In-memory-only state makes this a non-event in practice, but
  it should be stated.

## Open questions for the plan

1. **Grace mode for agents without `/identity`?** Strict is safer and
   simpler; lenient avoids a hard cutover. Recommendation: strict, since
   both binaries ship from this repo and there is no external fleet — but
   this is a real decision.
2. Should `GET /nodes` expose the canonical identity key, or keep it
   internal? Leaning internal, to avoid handing an attacker a collision
   oracle.
3. Does `PeerRegistry` need canonicalization even without the callback?
   Probably yes for consistency, and it is nearly free.
