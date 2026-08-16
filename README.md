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

**Current status:** 11 of the project's implementation plans are complete,
and Phase A of the request-routing initiative that follows them is done too
— see [`CLAUDE.md`](CLAUDE.md)'s Plan Roadmap for exactly what's built
versus what's still ahead. In short: the compute engine, a federated
coordinator service, a browser client, and a working end-to-end
request-routing path (`POST /generate`, routing a prompt through the safety
gate to a real `swarm-node-agent` and back) all work and are tested. What's
still missing is dynamic node selection instead of manual registration
(Phase B), background pre-warming/autoscaling of warm pipelines (Phase C),
and token streaming (Phase D). That's the natural next place to contribute.

## Get involved

This is early, real infrastructure — not a finished product — and it's
built in the open specifically so people can pick up a piece of it. Useful
ways to help right now:

- **Dynamic pipeline assembly, pre-warming, and streaming** — Phases B, C,
  and D of the request-routing initiative (see above); manual, single-node,
  non-streaming routing (Phase A) is done, but nothing dynamic,
  demand-driven, or streamed exists yet. Every existing piece (capacity
  tracking, safety gate, reputation, locality) is groundwork waiting for
  this.
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

Two more small models are available for testing against real, current
open-weight model families rather than only the TinyLlama fixture above:

```bash
./scripts/download_qwen_test_model.sh       # Qwen2.5 0.5B Instruct, ~490MB
./scripts/download_deepseek_test_model.sh   # DeepSeek-R1-Distill-Qwen 1.5B, ~1.1GB
```

Both are already wired into the coordinator's default model catalog
(`qwen2.5-0.5b`, `deepseek-r1-distill-qwen-1.5b` — see the Coordinator
service section below) and have been verified end-to-end through
`swarm-node-agent` and `POST /generate`. The DeepSeek download script uses
`curl -C -` (resume) with 8 retries — this specific file has been observed
to have its connection drop mid-transfer without curl reporting an error,
leaving a truncated file that still parses as a valid GGUF header but fails
to load at runtime; the checksum check catches this if it happens again.

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

## Node agent

`swarm-node-agent` (`core/src/node_agent_main.cpp`) is a long-lived process
that loads a model once at startup and serves it over HTTP, wrapping
`swarm::InferenceEngine`'s existing, unchanged public API:

```bash
./build/core/swarm-node-agent.exe --model models/tinyllama-1.1b-chat-v1.0.Q4_K_M.gguf --port 8081
```

CLI flags:

- `--model <path.gguf>` (required) — path to the GGUF model file.
- `--port N` (required) — port to bind on `127.0.0.1`.
- `--remote host:port` (repeatable, optional) — one or more `swarm-rpc-server`
  endpoints to shard the model across, same as `InferenceEngine`'s
  remote-device constructor.
- `--layer-placement N:endpoint` (repeatable, optional) — pin a specific
  layer's MoE expert tensors to a device endpoint (`local` or one of the
  `--remote` endpoints), same as `InferenceEngine`'s layer-placement
  constructor.

It exposes two HTTP endpoints:

- `GET /health` — returns `200 {"status":"ready"}` once the model has
  finished loading and the server is accepting connections. This reflects
  only that startup finished — it is **not** a live engine-health check.
  If a remote RPC device this agent depends on (via `--remote`) disappears
  mid-session, the underlying llama.cpp RPC transport aborts the whole
  process on the next request (an upstream `GGML_ABORT`, not a catchable
  C++ exception, so `/complete` cannot turn it into a clean error
  response). `/health` will keep reporting `ready` right up until that
  abort happens.
- `POST /complete` — body `{"prompt": "...", "n_predict": 64}`
  (`n_predict` optional, defaults to 64) returns `200 {"text": "..."}` with
  the generated completion. Returns `400` if `prompt` is missing or its
  value is not a JSON string (a number, `null`, `true`/`false`, a nested
  object, or an array are all rejected, not silently coerced). `n_predict`
  is capped at `512` — a value above that returns `400
  {"error":"n_predict must not exceed 512"}` rather than running (a large
  `n_predict` against `InferenceEngine`'s fixed context size can otherwise
  tie up this single-threaded server for minutes, blocking even `/health`,
  and then fail outright once the context is exhausted, discarding every
  token generated). Note the asymmetry: a non-numeric or otherwise
  malformed `n_predict` is **not** rejected — it silently falls back to the
  default (64); only a valid, in-range-parsed-but-out-of-bounds integer
  triggers the `400`. Even within the 512 cap, a single request can still
  take significant time depending on model size and node hardware — this
  cap bounds the worst case, it does not guarantee a fast response. Note
  that this cap bounds *generation* length only, not prompt processing
  time: live testing found that a request with a very long prompt (not a
  long `n_predict`) can still tie up this single-threaded agent for over a
  minute before failing, since there is currently no bound on prompt
  length or prompt-processing time at either the coordinator or the agent
  level.

JSON string values (like `prompt`) are decoded assuming standard
`JSON.stringify`-style escaping. A client using a JSON library that escapes
non-ASCII characters as `\uXXXX` for codepoints at or above `0x80` (e.g.
Python's `json.dumps` with its default `ensure_ascii=True`) will have those
characters corrupted, since only `\u00XX` (codepoints below `0x80`) is
decoded here. Requests built with `JSON.stringify` (as this project's
coordinator does) are unaffected for normal Unicode text. One narrow
exception: a lone/unpaired UTF-16 surrogate in a prompt (a rare, malformed
input, not a normal usage concern) is itself emitted by `JSON.stringify` as
a literal `\udXXX` escape sequence, which this agent's decoder does not
turn back into a real character — live-verified, it round-trips as the
6-character escape text, not a character. So the "coordinator is
unaffected" claim above does not fully cover this specific edge case.

Like `swarm-rpc-server`, this is a minimal building block: it serves one
request at a time, with no concurrency, request queueing, authentication,
or clean-shutdown path — it runs until killed. The coordinator's
`POST /generate` (see the Coordinator service section below) is now a real
caller of this agent's `POST /complete` endpoint — the first thing in this
repo to actually route a request to `InferenceEngine` over HTTP end to end.

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
  see the locality-grouping note below. Also accepts an optional
  `servesModel` string field (must be a known catalog model id when
  provided) declaring which model this node can serve inference requests
  for. Like `localityGroup`, this is **self-reported and unverified** — the
  coordinator does not check that a node actually has the declared model
  loaded and ready; `POST /generate` (see below) trusts it at routing time.
  Combined with the no-auth posture, this means anyone can register an
  endpoint claiming to serve a given model and start receiving real
  `/generate` traffic for it — see the known gaming vectors below for the
  sharper version of this involving reputation ejection.
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
  interface (`coordinator/src/safety_classifier.ts`).** `/classify` is
  also callable directly and independently of `/generate` below — it is
  not exclusively an internal implementation detail of routing.
- `POST /generate` — submit `{ "prompt": string, "modelId": string,
  "n_predict"?: number }`, get back `{ "text": string }`. Classifies the
  prompt first (fails closed on an unsafe prompt or a classifier error,
  same posture as `/classify`), finds an active node whose self-reported
  `servesModel` matches `modelId`, forwards the request to that node's
  `swarm-node-agent` `POST /complete` endpoint, and returns its generated
  text. Returns `400` if the request is invalid or the prompt was
  classified unsafe, `503` if no active node currently serves the
  requested model, `502` if the selected node is unreachable or returns a
  malformed response. `n_predict` defaults to 64 and is capped at 512,
  mirroring `swarm-node-agent`'s own cap. Single attempt only — no retry,
  no fallback to a different node on failure, no streaming (the response
  arrives complete or not at all). See the paragraph below for what this
  endpoint does and doesn't do yet.
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

**`POST /generate` is the first endpoint in this repo that produces a real
generated response.** Every other endpoint above it was groundwork —
registry, capacity, safety gate, reputation, locality — built ahead of a
request-routing system that didn't exist yet; this is that system's first
piece. It requires at least one `swarm-node-agent` process (see the Node
agent section above) to be running and registered via `POST
/nodes/register` with a `servesModel` value matching the requested
`modelId` — without one, every call to `/generate` returns `503`. That node
must also keep sending `POST /nodes/:nodeId/heartbeat` periodically (the
same 30-second liveness timeout every other endpoint relies on) — once it
ages out of the registry from a missed heartbeat, `/generate` stops finding
it and returns `503` again, exactly as if it had never registered. This is
still only Phase A of the request-routing initiative: node selection is a
simple first-match scan over active nodes (not load- or locality-aware),
there is no background pre-warming of pipelines ahead of demand, and there
is no token streaming (a `/generate` call blocks until the full response
is ready or the request fails). See
[`docs/superpowers/specs/2026-08-16-request-routing-design.md`](docs/superpowers/specs/2026-08-16-request-routing-design.md)
for Phases B (dynamic, coordinator-driven pipeline assembly), C
(pre-warming and demand-based autoscaling), and D (token streaming) — none
of which are implemented yet.

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
request on two independently-chosen nodes and comparing outputs) —
`POST /generate` (Phase A, see below) only selects and calls a single node
per request, with no redundant dispatch to a second node for comparison, so
this specific dual-node mechanism still doesn't exist. It only builds the
reputation ledger and ejection policy, ready to be wired into a future
dual-node dispatch path. Reputation endpoints themselves stay operable on an
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
Since `POST /generate` now exists, ejecting a legitimate node this way is
no longer just about restoring a `/capacity` count: verified live, an
attacker who has separately registered their own endpoint with a
`servesModel` matching the ejected node's model becomes the sole remaining
match for that model, so every subsequent `/generate` call for it —
including real user prompts — gets routed to the attacker's node, which can
return arbitrary attacker-controlled text as if it were the real model's
output. Separately, the disagreement ratio is all-time with no decay or windowing,
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
grouping; no pipeline-assembly or locality-aware request-routing system in
this repo yet consumes it — `POST /generate` (Phase A, see below) is a
simple first-match scan over active nodes with no locality-awareness at
all, and this repo still has no cross-instance (federated) or multi-node
pipeline-aware request routing of any kind. No client-side mesh-discovery
mechanism (WiFi Direct, Multipeer Connectivity, LAN broadcast) yet exists
to produce real, verifiable locality identifiers, either.
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

**`POST /generate` (and `SwarmClient.generate()`) is the one inference-request
path that exists today** — both the OpenAPI document and `SwarmClient`
describe/wrap it the same way as every other route. See the Coordinator
service section above for what it requires (a running, registered
`swarm-node-agent` with a matching `servesModel`) and what it still doesn't
do (dynamic node selection, pre-warming, or streaming — Phases B–D of the
request-routing design).

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

**The dashboard's own demo button does not run real inference.** It only
calls `POST /classify`, not `POST /generate` — a real inference-request
endpoint exists and works (see the Coordinator service section above), but
this dashboard was never wired up to call it, and the client visibly
discloses this gap in its own UI rather than faking it. The client is
same-origin only, with no authentication — matching the coordinator's
existing no-auth posture described above. As with the `/classify` endpoint
itself (see above), the shipped classifier has zero rules by default, so
the demo currently reports every prompt as `safe: true`; the dashboard's
own notice discloses this.
