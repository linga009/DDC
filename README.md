# swarm-llm

**A federated, open-source network for running open-weight LLMs on compute
people already own** — phones, laptops, desktops — instead of a single
company's data center. No central authority (Mastodon/Matrix-style
federation: anyone can run a coordinator instance and peer with others). No
cryptocurrency, token, or mining layer of any kind — this project exists to
give people free access to bigger and better open models by pooling idle
hardware, not to pay contributors in a coin. Full vision:
[`docs/superpowers/specs/2026-08-14-distributed-llm-inference-design.md`](docs/superpowers/specs/2026-08-14-distributed-llm-inference-design.md).

## Why this exists

Running a large open-weight model well requires more RAM/VRAM than almost
any single consumer device has. The usual answers are "pay a cloud
provider" or "run a small, worse model locally." This project's bet is a
third option: split a large model across many ordinary machines'
spare capacity — the same idea that makes a datacenter's fast interconnect
useful, applied to phones and laptops on a home network or the open
internet — and grow the set of models a swarm can serve as more people
contribute capacity, entirely for free. Every model stays open-weight;
nobody pays to participate, and nobody gets paid to contribute hardware.
Safety and consent are treated as first-class from the start (see the
safety-classifier gate and reputation/ejection sections below), not bolted
on later.

**`swarm-cli` is the proof that the hard part works today.** It's a real
`llama.cpp`-backed inference engine (`swarm::InferenceEngine`) that can
already split a single model's layers across a local device and one or more
networked peers via a minimal RPC mechanism, place Mixture-of-Experts
tensors on chosen devices, and verify several speculative tokens per
round-trip to cut latency. That's the computational core the whole
federated-swarm idea depends on — everything else in this repo (the
coordinator service, safety gate, reputation ledger, locality grouping, web
dashboard, developer API) exists to eventually route real requests to a
swarm of these engines instead of one.

**Current status:** 11 of the project's implementation plans are complete —
see [`CLAUDE.md`](CLAUDE.md)'s Plan Roadmap for exactly what's built versus
what's still ahead. In short: the compute engine, a federated coordinator
service, and a browser client all work and are tested; the one piece still
missing across every plan so far is the request-routing/pipeline-assembly
system that would let a client actually get a generated response back from
the swarm end-to-end. That's the natural next place to contribute.

## Get involved

This is early, real infrastructure — not a finished product — and it's
built in the open specifically so people can pick up a piece of it. Useful
ways to help right now:

- **Request routing / pipeline assembly** — the biggest open gap (see
  above). Every existing piece (capacity tracking, safety gate, reputation,
  locality) is groundwork waiting for this.
- **Client apps** — this repo currently ships a browser dashboard only
  (native mobile/desktop apps were deliberately deferred — see
  [`CLAUDE.md`](CLAUDE.md)'s Plan 10 note for why).
- **Testing on real hardware** — everything so far has been built and
  tested on a single Windows dev machine; multi-machine, multi-platform,
  real-network testing would surface things a single-box test suite can't.
- **Model coverage and sharding strategy** — MoE layer placement and
  speculative decoding exist; there's a lot of room to improve throughput
  and model support.

Start with [`CLAUDE.md`](CLAUDE.md) for repo layout, conventions, and the
development workflow this project follows for every change (plan → review →
merge, with an emphasis on live-tested behavior over code-review-only
sign-off). Open an issue or a PR — there's no formal process yet beyond
that.

## Prerequisites

- **Windows:** [MSYS2](https://www.msys2.org/) with the MinGW-w64 UCRT64
  toolchain (`mingw-w64-ucrt-x86_64-gcc`, `mingw-w64-ucrt-x86_64-cmake`,
  `mingw-w64-ucrt-x86_64-ninja`).
- **Linux/macOS:** an equivalent C++17 toolchain (GCC or Clang, CMake, and
  Ninja).

## Clone

```bash
git clone --recurse-submodules https://github.com/linga009/DDC.git
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init
```

## Download the test model

```bash
./scripts/download_test_model.sh
./scripts/download_moe_test_model.sh
```

This downloads a small TinyLlama GGUF model into `models/` for use by the
test suite and the `swarm-cli` example below. The second script fetches a
~90MB MoE (mixture-of-experts) model used by the layer-placement tests.

## Build

```bash
cmake -G Ninja -S . -B build
cmake --build build
```

## Run the tests

```bash
./build/core/tests/inference_engine_test.exe
```

or, from the build directory:

```bash
cd build && ctest
```

## Run swarm-cli

```bash
./build/core/swarm-cli.exe --model models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf "The capital of France is"
```

Example output:

```
The capital of France is Paris.
```

## Networking and RPC sharding

This repo includes a first, minimal step toward multi-node inference, built
on llama.cpp's RPC backend:

- **`swarm-rpc-server`** — a small executable (`core/src/rpc_server_main.cpp`)
  that exposes the local CPU device so another process can offload
  computation to it. Run it with `--port N`. It binds to `127.0.0.1` only —
  there is currently no option to bind another interface, so it is reachable
  only from the same machine.
- **`swarm::InferenceEngine`** has a second constructor overload,
  `InferenceEngine(model_path, remote_endpoints)`, that combines the local
  CPU device with one or more remote devices reached via `swarm-rpc-server`
  instances, so model layers can be split across the local machine and
  remote hosts.

> [!WARNING]
> The underlying llama.cpp RPC backend is, in upstream's own words, "in a
> proof-of-concept development stage. As such, the functionality is fragile
> and insecure." **Never run `swarm-rpc-server` on an open or untrusted
> network.** It has no authentication or encryption. It is suitable for
> trusted LAN or same-host use only, and currently binds to `127.0.0.1` for
> exactly this reason.

## Coordinator service

`coordinator/` is a small HTTP service that tracks which nodes are alive and
uses their count to gate which models in the catalog are announced as
available. It requires Node.js 22.6+ (native TypeScript support — no build
step, and it has zero npm dependencies).

Run its tests:

```bash
cd coordinator && npm test
```

Start it:

```bash
PORT=8080 node src/main.ts
```

Endpoints:

- `POST /nodes/register` — register a node, returns a `nodeId`. Accepts an
  optional `localityGroup` string field (must be non-empty when provided) —
  see the locality-grouping note below.
- `POST /nodes/:nodeId/heartbeat` — refresh a node's liveness
- `GET /nodes` — list currently active nodes
- `GET /nodes/locality` — active nodes bucketed by their self-reported
  `localityGroup`: `{ [group: string]: NodeInfo[] }`. A node registered
  without a `localityGroup` is bucketed under `"ungrouped"`. Uses the same
  reputation filtering as `GET /nodes` — an ejected node does not appear in
  any group.
- `GET /catalog` — list models with `available` gated on active node count
- `GET /capacity` — report this instance's active node count, for peers to fetch
- `POST /peers/register` — register a federated peer instance, returns a `peerId`
- `POST /peers/:peerId/heartbeat` — refresh a peer's liveness
- `GET /peers` — list currently active peers
- `DELETE /peers/:peerId` — deregister a peer
- `POST /classify` — pluggable safety gate: submit `{ "prompt": string }`,
  get back `{ safe: boolean, categories: string[] }`. **The shipped
  `KeywordSafetyClassifier` ships with zero rules by default and performs no
  real content moderation — it exists only to prove the gate's plumbing
  (fail-closed error handling, request/response shape, timeout behavior). A
  real classifier must be supplied by implementing the `SafetyClassifier`
  interface (`coordinator/src/safety_classifier.ts`).** `/classify` is also
  not yet wired into any request-submission path — nothing currently calls
  it automatically before routing a prompt for inference.
- `POST /nodes/:nodeId/reputation/agree` / `POST /nodes/:nodeId/reputation/disagree`
  — record that a node's output agreed or disagreed with a redundant
  spot-check computation (204, or 404 if `nodeId` is unknown)
- `GET /nodes/:nodeId/reputation` — report a node's reputation stats:
  `{ agreements: number, disagreements: number, trusted: boolean }`
- `GET /` — serves the web dashboard (see Web client section below)
- `GET /app.js` — serves the web dashboard's client-side JavaScript (see Web
  client section below)
- `GET /style.css` — serves the web dashboard's stylesheet (see Web client
  section below)
- `GET /openapi.json` — serves the hand-written OpenAPI 3.0 document
  describing the JSON API routes above (see Developer API section below)

A node with zero recorded checks is trusted by default. Ejection (excluding
the node from `GET /nodes`, `GET /capacity`, and `/catalog`'s active-node
count) requires both a minimum sample size and a disagreement rate at or
above threshold — the defaults are `minSamples=5` and
`disagreementThreshold=0.5`, and neither is currently runtime-configurable
(both are `ReputationTracker` constructor parameters, hardcoded at their
defaults in `main.ts`). This means a node doesn't eject on a single sample.
This is not a defense against a malicious caller — the minSamples/threshold
gate exists to absorb noisy or unlucky spot-check results, not adversarial
ones; see the no-auth caveat below. **The coordinator does not implement
the actual redundant-computation spot-check mechanism** (running the same
request on two nodes and comparing outputs) — that requires a
request-routing system this repo doesn't have yet. It only builds the
reputation ledger and ejection policy, ready to be wired in once routing
exists. Reputation endpoints themselves stay operable on an
already-ejected node (so future spot-check results can still be recorded
for it) — only capacity-facing views exclude it.

**Caveat:** there is no authentication, and by default the server binds only
to `127.0.0.1`; setting `HOST` to bind wider (e.g. `0.0.0.0`) should only be
done on trusted networks. Federation compounds this: once a peer is
registered, this instance makes an outbound HTTP request to it on every
`GET /catalog` call, and `POST /peers/register` itself is unauthenticated,
so anyone able to reach this instance can add outbound request targets.
The reputation-recording endpoints are likewise unauthenticated — currently
any caller can record arbitrary agreement/disagreement events for any node.
Reputation state is in-memory only and does not persist across restarts.

**Known gaming vectors:** reputation is keyed by `nodeId`, and
`NodeRegistry.register()` mints a fresh `randomUUID()` on every call with no
endpoint dedupe (unlike `PeerRegistry`, which dedupes registrations by
endpoint) — so an ejected node clears its record with one more
`POST /nodes/register` call, restoring its `/capacity` count immediately.
Verified live: 5 disagreements ejects a node; one re-register call and
it's back with a clean slate. This is a stronger, cheaper vector than a
node simply avoiding ever being spot-checked to stay perpetually
"unproven, therefore trusted" under the zero-checks-trusted default above.
Separately, the disagreement ratio is all-time with no decay or windowing,
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

**Locality grouping is self-reported and unverified:** `localityGroup` is an
arbitrary string a node supplies at registration time — the coordinator
performs no check that it reflects real physical or network proximity. A
node can claim membership in any group, including one it has no actual
adjacency to, with no cost or detection (the same no-auth caveat above
applies here too). This is worse than a single false claim: because
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
matters beyond the general no-auth caveat because `GET /nodes/locality`
exists as groundwork for a future pipeline assembler that will likely
prefer larger or majority locality clusters when selecting nodes — making
this a vector against the exact consumer this endpoint is groundwork for.
The root cause is the same missing stable-node-identity fix already named
as a prerequisite in the reputation gaming-vectors note above; see that
paragraph rather than repeating it here. Separately, a node can also
register with `localityGroup: "ungrouped"` verbatim, which is
indistinguishable from a node that never set the field at all. `GET
/nodes/locality` exists purely as a stable, queryable interface for
grouping; no pipeline-assembly or request-routing system in this repo yet
consumes it (see the federation caveat above — this repo has no
cross-instance or cross-node request routing at all yet), and no
client-side mesh-discovery mechanism (WiFi Direct, Multipeer Connectivity,
LAN broadcast) yet exists to produce real, verifiable locality identifiers.
Both are expected to be built against this interface later.

## Developer API

For programmatic access to the coordinator, two things exist:

- **`GET /openapi.json`** — a hand-written OpenAPI 3.0 document describing
  every JSON API endpoint listed above (the static dashboard routes and
  `/openapi.json` itself are excluded). Point standard OpenAPI tooling
  (Swagger UI, client codegen, Postman, etc.) at
  `http://<host>:<port>/openapi.json` on a running instance to explore the
  API or generate a client for it. It is hand-written, not generated from
  the route code, so it can drift from actual behavior if a route's
  request/response shape changes without the doc being updated — a test in
  `coordinator/tests/server.test.ts` only catches a documented path
  disappearing, not a shape drifting.
- **`coordinator/src/client.ts`** — a minimal `SwarmClient` class, one typed
  method per JSON API endpoint listed above (the static dashboard routes
  and `/openapi.json` itself are excluded), that talks to those routes
  directly (independent of the OpenAPI document). It is plain TypeScript
  with zero dependencies (only native `fetch`) and runs directly under
  Node.js's native TypeScript execution, no build step — developers can
  import it as-is or copy it as a starting point for their own client.
  Every method accepts an optional trailing `signal?: AbortSignal` so a
  caller can bound a request (e.g. `client.getCapacity(AbortSignal.timeout(2000))`);
  the client itself imposes no default or automatic timeout.

**There is still no inference-request endpoint.** Both of the above only
wrap or describe the coordinator's existing registry, capacity, federation,
safety-gate, reputation, and locality routes — no request-routing or
pipeline-assembly system exists yet in this repo (see the Coordinator
service section above), so neither one has anything that actually submits a
prompt for inference and returns a generated response.

## Web client

When the coordinator is running, it serves a small browser dashboard at `/`
(plain HTML/CSS/vanilla JS — no build step, no framework, no new npm
dependency; the files live in `coordinator/public/` and are served by the
`GET /`, `GET /app.js`, and `GET /style.css` routes listed in the endpoint
list above). It shows:

- **Swarm status** — the active node count (local + federated, from
  `GET /capacity`) and the model catalog with each entry's minimum
  active-node threshold and current availability (from `GET /catalog`),
  polled every 5 seconds.
- **A `/classify` demo** — a text box and button that submit a prompt to
  `POST /classify` and display the resulting `safe`/`categories` verdict.

**The dashboard does not run real inference.** It only demonstrates the
existing safety-gate endpoint; there is no request-routing/pipeline-assembly
system anywhere in this repo yet to actually generate a response from a
model, so the client visibly discloses this in its own UI rather than
faking it. The client is same-origin only, with no authentication — matching
the coordinator's existing no-auth posture described above. As with the
`/classify` endpoint itself (see above), the shipped classifier has zero
rules by default, so the demo currently reports every prompt as `safe:
true`; the dashboard's own notice discloses this.
