# Phase B: Dynamic Pipeline Assembly — Implementation Design

## Background

This supersedes/elaborates the original forward-looking sketch at
[`docs/superpowers/specs/2026-08-16-phase-b-dynamic-pipeline-assembly-design.md`](docs/superpowers/specs/2026-08-16-phase-b-dynamic-pipeline-assembly-design.md),
written before Phases A/D or any of the Security Hardening initiative
existed, and explicitly flagged in `CLAUDE.md` as needing re-validation
before implementation. That doc's Summary, Goals, launcher-based
architecture, and node-selection sketch are still sound — this doc grounds
every claim against the real current source
(`coordinator/src/registry.ts`, `reputation_tracker.ts`, `catalog.ts`,
`server.ts`, `core/src/node_agent_main.cpp`, `core/src/rpc_server_main.cpp`
— all read fresh as of 2026-08-22, not from memory) and resolves the
original doc's four Open Questions into concrete decisions, made explicitly
with the user rather than assumed — in particular the launcher's security
posture, the single biggest risk the original doc named and deliberately
left unresolved.

Phase A (manual pipeline composition, `POST /generate`) and Phase D (token
streaming) are both done and merged. This is the next phase in the request
routing initiative; Phase C (pre-warming/autoscaling, still design-only)
remains out of scope, as it was in the original doc.

## Goals

- Given a model whose catalog entry declares it needs more than one node,
  have the coordinator select which nodes should form a pipeline — one
  **driver** (holds the model, receives `/complete` calls) and zero or more
  **compute contributors** (run `swarm-rpc-server`, no model) — from the
  registry/reputation/locality data every prior plan already built.
- Actually cause that selection to become a running, HTTP-reachable
  pipeline via a new **launcher** role, not just compute an opinion about
  it.
- Track pipeline lifecycle (assembling / warm / stale / failed) as a
  first-class coordinator concept `/generate` consults before falling back
  to today's flat active-node scan.
- **Resolve the launcher's trust model explicitly**, since it is a
  materially larger blast radius than anything built so far — every
  existing gap in this project is "misroute or receive traffic meant for
  someone else"; a compromised launcher command is "run a process on my
  machine."

## Non-Goals

(Unchanged from the original doc — still correct.)

- **Multiple concurrent warm pipelines per model, or scaling their count
  with demand** — Phase C. Phase B assumes one pipeline per model is
  enough to prove dynamic assembly works.
- **Triggering assembly proactively, ahead of a request arriving** — also
  Phase C. Phase B triggers assembly synchronously, on the first request
  that needs a pipeline that doesn't exist yet or has gone stale, accepting
  the added latency on that one request.
- **Token streaming** — Phase D, already done, unrelated axis. A
  launcher-assembled pipeline's driver still speaks the same `/complete`
  (streaming and non-streaming) that Phase A/D already built; nothing here
  changes that contract.
- **Changing `InferenceEngine`'s sharding logic.** Phase B only decides
  *which* nodes and *what* layer placement to pass to the existing,
  unchanged `--remote`/`--layer-placement` flags.
- **TLS, or changing the swarm-wide `SWARM_AUTH_TOKEN` model for the
  coordinator's own API.** Out of scope — see Architecture #2 for why the
  launcher gets a *different* posture instead of reusing that token.

## Architecture

### 1. Model-to-pipeline-shape mapping (`coordinator/src/catalog.ts`)

Read fresh: `CatalogEntry` today is `{ id, displayName, minActiveNodes }`.
`minActiveNodes` is a **swarm-wide capacity gate** ("are there at least N
nodes active anywhere before this model is considered available at all"),
not a per-request pipeline-shape decision — nothing in the current catalog
says a specific model actually *needs* more than one node to run. Phase B
needs that distinction, since it's what decides whether `/generate` ever
needs the launcher path at all.

Add one field: `requiredNodeCount?: number` — the total pipeline size
(driver plus compute contributors together, not contributors alone),
default `1` when absent so every existing catalog entry keeps today's
single-node behavior with zero changes. A model with `requiredNodeCount === 1` never touches any of the
machinery below; `/generate` behaves exactly as it does on `master` today.
Only `requiredNodeCount > 1` models (realistically the catalog's existing
`mixtral-8x7b`/`mixtral-8x22b` entries, which already have elevated
`minActiveNodes`) engage Phase B's assembly path.

### 2. The launcher's trust model (resolved, not deferred)

**Decision, made explicitly with the user rather than assumed: the
launcher binds to `127.0.0.1` only, with no bearer-token auth of its own.**
Reachability *is* the trust boundary — a remote coordinator reaches a
launcher on a different machine only through a channel the driver's
operator explicitly sets up (SSH port-forward or a WireGuard tunnel),
mirroring `swarm-rpc-server`'s own already-established posture for a
comparably dangerous surface: `core/src/rpc_server_main.cpp` binds
`127.0.0.1` unconditionally and prints *"the RPC backend is insecure and
intended for trusted LAN or same-host use only -- never expose it to an
untrusted network"* — no auth hook exists in its public API, and this
project already treats that as the correct, disclosed answer rather than a
gap. The launcher adopts the identical posture rather than inventing a
second, weaker pattern (a new bearer token, over this project's
by-design-no-TLS plain HTTP) for an even more dangerous surface.

**This decision costs zero new binding code, and is not actually a new
posture for this project at all — confirmed by reading, not assumed:**
`core/src/http_server.cpp`'s `HttpServer` (the *exact same* class
`swarm-node-agent`'s `/health`/`/complete` already run on) hardcodes
`addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK)` in its own bind call —
every server built on `HttpServer` has *always* been loopback-only, not
just `swarm-rpc-server`. This means the launcher inherits the identical
restriction automatically just by being built on `HttpServer` like every
other binary in `core/` — no new socket code, and no new *kind* of
constraint being introduced to this project. It also reframes what "real
cross-machine operation" has actually meant here all along: every existing
HTTP hop (coordinator↔node-agent) and RPC hop (node-agent↔`swarm-rpc-server`)
already requires the operator to bridge loopback-only endpoints across
machines themselves (a tunnel, or genuinely co-located processes) — this
design doesn't invent that requirement for the launcher, it's simply the
first time it's been stated explicitly rather than left implicit in a bind
call nobody had occasion to point at directly.

**Two alternatives were considered and explicitly rejected, ranked on
actual safety, not convenience:**
- **Reuse `SWARM_AUTH_TOKEN`.** Rejected: escalates that token's blast
  radius from "misroute prompts" to "arbitrary code execution," for every
  existing token-holder — and that token is already disclosed (Security
  Hardening Phase 1) as forwarded in cleartext to any endpoint a registered
  node claims, so this would make an already-known exposure into a
  code-execution key.
- **A separate `LAUNCHER_AUTH_TOKEN`.** Rejected as the primary mechanism:
  strictly safer than reusing the swarm token (contains a leak instead of
  compounding it), but it's still a bearer-token-over-plain-HTTP scheme —
  the same exposure *class* this project already has, just a second
  instance of it — where localhost-only binding eliminates the exposure
  class entirely instead of mitigating it.

**Named cost of this decision, not hidden**: a volunteer who wants to
contribute a driver machine cannot join purely by running the launcher and
sharing a secret — they (or the coordinator operator) must set up a tunnel
first. This is a real friction cost against this project's own "grow the
swarm as strangers contribute capacity" framing, and is disclosed as an
accepted tradeoff, the same way `swarm-rpc-server`'s identical constraint
already is, rather than something Phase B tries to solve.

Launcher HTTP contract, run as its own new binary (`swarm-launcher`,
paralleling `swarm-node-agent`/`swarm-rpc-server`'s existing one-binary-one-job
pattern in `core/`):

```
POST /pipeline
{ "model": "mixtral-8x7b", "remoteEndpoints": "127.0.0.1:50060,127.0.0.1:50061",
  "layerPlacements": "0:127.0.0.1:50060,16:127.0.0.1:50061" }
```

**Three things the original sketch's request shape left unresolved, all
closed here rather than left for plan-time guesswork:**

- **No `agentPort` in the request.** The original sketch had the
  coordinator dictate the spawned agent's port per call — but the spawned
  agent is *also* loopback-only (Architecture #2's `HttpServer` finding
  applies to it too), so the coordinator can only ever reach it through
  the same tunnel that reaches the launcher. A tunnel the operator sets up
  once can only forward ports known in advance; a port chosen fresh by the
  coordinator on each reassembly can't be pre-tunneled. Resolved the same
  way as `--models-dir`: the launcher takes its own `--agent-port N` flag
  at startup, fixed for that launcher's whole lifetime. The operator
  tunnels exactly two known ports once (the launcher's own, and this
  fixed agent port) and never has to redo that setup on reassembly. The
  coordinator learns this port from the launcher's own registration
  (Architecture #2b adds it to `LauncherInfo`), not from choosing one
  itself.

- **No JSON arrays.** `core/include/swarm/json_utils.h` is explicitly
  documented as a top-level-scalar-only extractor, deliberately *not* a
  general JSON parser and not meant to grow toward one (confirmed by
  reading it fresh). `remoteEndpoints` and `layerPlacements` are therefore
  comma-separated strings, not JSON arrays — `remoteEndpoints` splits
  directly into repeated `--remote <endpoint>` flags;
  `layerPlacements`'s entries are already in `swarm-node-agent`'s own
  `N:endpoint` shape (`core/src/node_agent_main.cpp`'s
  `parseLayerPlacement`), so the launcher only needs to split on commas
  and pass each piece straight through as its own `--layer-placement`
  value — no re-parsing of the `N:endpoint` shape needed on the launcher's
  side at all.
- **No `modelPath`.** The original sketch implied the coordinator would
  supply one, but the coordinator cannot know a valid path on an arbitrary
  driver machine — two drivers can (and, across real operators, will)
  store the same model at different local paths. Resolving this is the
  launcher's own job: it takes a `--models-dir <path>` flag at its own
  startup (mirroring `swarm-node-agent`'s existing `--model <path>`
  pattern) and expects `<models-dir>/<model>.gguf` to exist — a disclosed,
  locally-configured convention, consistent with this project's existing
  "self-reported and locally-configured, not centrally dictated" posture
  for `deviceTier`/`localityGroup`/`servesModel`. A request naming a model
  the launcher has no file for is a real, reported `404`-equivalent
  error, not a confusing downstream `InferenceEngine` failure three
  layers removed from the actual cause.

The launcher itself still needs `SWARM_AUTH_TOKEN` in its own process
environment (refusing to start without it, matching the fail-fast posture
every other component already has for this variable) — not to authenticate
*incoming* `POST /pipeline` calls (trust there is structural, via
localhost-only reachability, per the decision above), but because it must
send `Authorization: Bearer <token>` when it polls the `/health` endpoint
of the `swarm-node-agent` it just spawned, which requires that header like
every other endpoint in this swarm.

Kills any `swarm-node-agent` this launcher previously started (if
reassembling), spawns a fresh one with `--port <its own fixed --agent-port>`
plus those flags, polls its `/health` until `200`, responds
`200 {"status":"ready"}` to the coordinator once confirmed ready (or a real
error status/body if the model file is missing, the spawn fails, or the
health-poll times out). The coordinator already knows which launcher URL it
called and that launcher's registered `agentPort` (Architecture #2b), so it
can construct the new agent's own endpoint itself — same host as the
launcher URL it just called, that fixed port — without the launcher's
response needing to echo anything back. No new C++ HTTP surface needed
beyond this one route — reuses `HttpServer`/`ResponseWriter` from Phase
D's own work, non-streaming only.

### 2b. Launcher discovery (`coordinator/src/launcher_registry.ts`, new)

A third gap the original sketch didn't specify: *how does the coordinator
know a launcher exists, or where to reach it?* A launcher isn't a `NodeInfo`
— nothing has been spawned yet, so there's no `/complete`-serving endpoint
to register via the existing `POST /nodes/register`. This needs its own
small registry, and the closest existing precedent is
`coordinator/src/peer_registry.ts` (read fresh: `register(endpoint):
peerId`, endpoint-match-refreshes-instead-of-duplicating, `heartbeat`,
`listActive()`, 30s timeout) — a `LauncherRegistry` mirrors that shape
exactly, with two additions: a launcher declares which models it's able to
serve as driver for (i.e., which are present under its own
`--models-dir`), so pipeline assembly can find one that actually has the
needed model instead of trying every registered launcher in turn; and it
reports its own fixed `agentPort` (Architecture #2's `--agent-port`), so
the coordinator can construct a freshly-assembled driver's endpoint without
the launcher needing to echo it back on every `POST /pipeline` call:

```typescript
export interface LauncherInfo {
  launcherId: string;
  endpoint: string;
  servesModels: string[];
  agentPort: number;
}
```

New route `POST /launchers/register` (`{endpoint, servesModels, agentPort}`
→ `{launcherId}`) and `POST /launchers/:launcherId/heartbeat`, both requiring
the bearer token like every other coordinator route — this is coordinator
API surface, governed by the existing swarm-wide auth model, entirely
separate from the launcher's own localhost-only HTTP surface described
above. The operator running a launcher registers it with the coordinator
the same way they already register a manually-run `swarm-node-agent`
today — a one-time (well, heartbeat-refreshed) setup step, not something
Phase B tries to automate discovery of.

### 3. Per-node capability data (`coordinator/src/registry.ts`)

Read fresh: `NodeInfo` today is `{ nodeId, endpoint, deviceTier,
localityGroup?, servesModel? }` — nothing describing available memory or
compute, confirmed still true. Add one more optional, self-reported field
at registration: `availableMemoryMb?: number` — unverified, exactly like
`deviceTier`/`localityGroup`/`servesModel` already are (this project's
established, disclosed posture: self-reported fields answer "who may talk
to the service", never "is what they claim true").

**Used as a soft preference, not a hard gate** — deliberately not "filter
out nodes below a per-model memory requirement," since that would need a
second new number (how much memory each catalog model actually needs) this
design has no honest basis for: this project's own catalog entries span
TinyLlama-1.1B through Mixtral-8x22B, and fabricating a threshold per
model without real measurement data would be worse than not gating at all.
Instead, among already-reputation-trusted candidates, a higher
self-reported `availableMemoryMb` is preferred when picking a driver — a
directionally-safe bias (more memory is never a worse bet) that needs no
invented per-model number, not a correctness guarantee. A node reporting
nothing sorts as if it reported `0`, the same fail-open posture
`deviceTier` already has for "can we trust this claim at all" — it can
still be picked, just not preferred over a node that reported more.

### 4. Node selection (`coordinator/src/pipeline_selector.ts`, new, pure function)

Given `requiredNodeCount`, the live `NodeRegistry`/`ReputationTracker`
state, and a target model:

1. `registry.listActive(reputation)` — the same existing choke point every
   other filtering mechanism in this project already reuses (registered in
   `CLAUDE.md` as the established pattern since Plan 3). Already trust-filtered;
   no separate capability-based exclusion step.
2. Pick the driver: highest `ReputationTracker.score()` first (reuses
   Security Hardening Phase 4's existing scoring method verbatim, no new
   ranking logic), `availableMemoryMb` (absent treated as `0`) as the
   tiebreak among equal scores.
3. Pick `requiredNodeCount - 1` **compute contributors**: prefer candidates
   sharing the driver's `localityGroup` (via `registry.groupByLocality()`,
   already built in Plan 9 for exactly this purpose), then fall back to any
   remaining trusted candidate, again ranked by `score()`.
4. Layer placement: for a model needing per-layer sharding, an even split
   across the chosen device count, in device order — this project's
   existing `--layer-placement` flag and `InferenceEngine`'s per-layer
   `tensor_buft_overrides` already support explicit per-layer assignment;
   Phase B computes a reasonable default split, not a bin-packing
   optimizer.

Pure function, no HTTP/launcher plumbing inside it, per this project's
established testing convention (Testing Considerations below).

### 5. Pipeline lifecycle tracking (`coordinator/src/pipeline_tracker.ts`, new)

A new, small class mirroring `NodeRegistry`'s own shape (in-memory only,
same as every other piece of coordinator state — no new persistence
model): `Map<modelId, { driverNodeId, computeNodeIds, state: "warm" |
"assembling" | "failed" }>`.

`/generate`'s existing node-selection step (`coordinator/src/server.ts`,
today: `selectNode(registry.listActive(reputation), reputation, modelId,
random)`) gains a preceding check, only for `requiredNodeCount > 1` models:

1. A tracked, `"warm"` pipeline exists for this model, and its driver is
   still in `registry.listActive(reputation)` → route to it exactly like
   today (no behavior change from the caller's point of view).
2. No tracked pipeline, or its driver has aged out / been reputation-ejected
   (i.e., no longer in `listActive()`) → look up `launcherRegistry.findForModel(modelId)`
   (Architecture #2b); if one is registered, synchronously call the node
   selector (#4) then that launcher (#2) to assemble a fresh pipeline; on
   success, register the driver via the registry exactly like a manual
   `POST /nodes/register` would, mark it `"warm"`, and proceed with this
   request. This is the design doc's own minimal answer to reassembly,
   confirmed still sufficient: staleness detection is just "is the driver
   still in the set `listActive()` already recomputes every call," no new
   liveness machinery needed.
3. `launcherRegistry.findForModel(modelId)` finds nothing, or the launcher
   call fails (a spawn failure, a missing model file, a `/health` timeout)
   → fall back to whatever's already manually registered for this
   `servesModel`, i.e. today's Phase A behavior, unchanged. `requiredNodeCount
   > 1` models with no operator-run launcher registered anywhere are simply
   never assembled automatically — the same "acceptable degradation, not a
   gap" the original doc already named for this case.

## Rejected Approaches

- **Reconfiguring an already-running `swarm-node-agent`'s pipeline shape
  over HTTP**, instead of the launcher/spawn-a-fresh-process model.
  Rejected for the same reason the original doc gave, re-confirmed still
  true: `InferenceEngine` is constructed once at process startup from CLI
  flags (`core/src/node_agent_main.cpp`, unchanged), so any reshaping
  still means destroying and reconstructing it — a full model reload —
  regardless of which mechanism triggers it. A same-process API wouldn't
  actually avoid the cost the launcher already accepts.
- **A separate `LAUNCHER_AUTH_TOKEN`, as the launcher's primary security
  mechanism.** Rejected in favor of localhost-only binding — see
  Architecture #2. (Not rejected as a concept entirely: nothing here
  prevents an operator from *also* putting the launcher behind their own
  reverse-proxy auth if they want defense in depth; the point is that this
  project doesn't build or require one.)
- **Extending `swarm-node-agent` itself to supervise/relaunch its own
  process**, instead of a separate launcher binary. Rejected for the same
  reason the original doc gave: `swarm-node-agent` deliberately has zero
  process-management responsibility today, mirroring `swarm-rpc-server`'s
  "does one thing" posture; blurring that boundary would complicate its
  already-reviewed lifetime/lambda-capture reasoning (Phase A/D's
  whole-branch reviews) for a genuinely separate concern.

## Open Questions

All four of the original doc's Open Questions are now resolved (see
Architecture #2 for the launcher trust model, #3 for capability data, #5
for reassembly triggering and the no-launcher-available fallback). No new
open questions were introduced by this pass — the remaining unknowns are
implementation-time details (exact layer-split heuristic tuning, exact
`swarm-launcher` CLI flag names) appropriate for the plan, not this design.

## Testing Considerations

- **Node selection (`pipeline_selector.ts`) tested as a pure function**,
  independent of the launcher/HTTP plumbing: given a constructed
  registry/reputation state and a target `requiredNodeCount`, does it pick
  the node set a human would expect (driver = highest score meeting the
  memory floor; contributors = same-locality-group preferred, ranked by
  score)? No live process needed for this layer.
- **The launcher is a new process-spawning surface** — needs the same
  rigor Phase A's `HttpServer`/`swarm-node-agent` got: real subprocess
  spawning in tests (not mocked), adversarial input handling (a malformed
  model path, an unreachable `--remote` endpoint, a port already in use),
  and resource-cleanup verification (orphaned child processes left running
  after a test are a real, previously-hit risk in this project's own
  fixtures — see `NodeAgentFixture`'s `taskkill`-based cleanup in
  `core/tests/node_agent_test.cpp`).
- **Localhost-only binding needs a real, live-verified check**, not just a
  code read: confirm the launcher genuinely refuses a connection from a
  non-loopback source in this environment (bind to `127.0.0.1` explicitly,
  not `0.0.0.0` with a comment promising restriction). `swarm-rpc-server`'s
  own precedent was checked during this design's own grounding pass, not
  just cited from memory: `core/src/rpc_server_main.cpp` hardcodes
  `"127.0.0.1:" + port` as the endpoint string, and
  `vendor/llama.cpp/ggml/src/ggml-rpc/ggml-rpc.cpp`'s
  `ggml_backend_rpc_start_server()` genuinely threads that parsed host
  through to `socket_t::create_server(host.c_str(), port)` for the actual
  listening socket — confirmed a real bind restriction, not just a
  discouraging log line. The launcher's own implementation needs the same
  live confirmation, not an assumption that "127.0.0.1 in the code" is
  automatically equivalent to "actually unreachable remotely."
- **`LauncherRegistry`** (Architecture #2b) needs the same test coverage
  its `PeerRegistry` precedent already has: register-refreshes-not-duplicates
  for a repeated endpoint, heartbeat renewal, expiry pruning on
  `listActive()`, and — new relative to `PeerRegistry` — `findForModel()`
  correctly matching only launchers that declared the requested model in
  their own `servesModels`.
- **The `--models-dir` resolution path** needs its own real (not mocked)
  coverage: a request naming a model with no corresponding
  `<models-dir>/<model>.gguf` file must fail with a clear, specific error
  before ever attempting to spawn anything — not a generic spawn failure
  three layers removed from "the file doesn't exist," and not a silent
  fall-through to spawning `swarm-node-agent` with a bad path anyway.
- **`/generate`'s new pre-selection check** (tracked-pipeline lookup,
  staleness detection, launcher-triggered reassembly, and the
  no-launcher-available fallback) needs real HTTP tests against this
  project's established `startTestServer`/real-stub-node pattern — covering
  all three branches in Architecture #5 (warm and reachable; stale,
  triggers reassembly; launcher absent or assembly fails, falls back to
  manual).
- **Live-adversarial-probing whole-branch review is essential here**
  (this project's established, consistently bug-finding practice) given
  the launcher is a genuinely new class of risk nothing built so far has
  had. In particular: confirm live that the launcher genuinely refuses a
  non-loopback connection attempt — this design's own grounding pass
  already confirmed, by reading the actual code (`core/src/http_server.cpp`'s
  `bind()` call, and separately `ggml_backend_rpc_start_server()`'s real
  socket-creation call for `swarm-rpc-server`'s own identical constraint),
  that `HttpServer` itself enforces this for every server built on it —
  so the live check here is really "does the launcher's `main()` construct
  a plain `HttpServer(port)` with nothing overriding that bind," not
  "does new, bespoke binding logic work correctly." Still worth confirming
  live rather than by code-reading alone, matching this project's
  established practice, but the risk surface is much smaller than writing
  new socket code would have been. Also confirm a spawned
  `swarm-node-agent` that fails to become healthy (bad model file,
  port collision) is cleaned up rather than left orphaned; and confirm a
  real end-to-end pipeline assembly (coordinator → launcher → spawned
  agent → registered with the coordinator → served a real `/generate`
  request) against a real multi-device setup, mirroring how Phase A's own
  whole-branch review required a real `--remote`-sharded run, not just a
  single-device one.
